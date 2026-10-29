import { SUBJECTS, TRACKS, BANK, BANK_SIZE } from './questions.js';

const LEGACY_RECORD_KEY = 'ipas-ai-exam-v1';
const LEGACY_EXAM_KEY = 'ipas-ai-active-v1';
const DURATION = 90 * 60 * 1000;
const $ = selector => document.querySelector(selector);
const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const dateText = value => new Intl.DateTimeFormat('zh-TW', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
let records = [];
let active = null;
let view = 'home';
let current = 0;
let selectedRecord = null;
let filterPerson = null;
let filterTrack = 'all';
let saving = false;
let finishing = false;
let lastFinishAttempt = 0;

async function api(path, options={}) {
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers}});
  const data=await response.json();
  if (!response.ok) { const error=new Error(data.message || '伺服器請求失敗'); error.status=response.status; error.data=data; throw error; }
  return data;
}
const payload = value => JSON.stringify(value);
function requestError(error) { toast(error instanceof TypeError ? '無法連線到伺服器，請確認服務仍在運作。' : error.message); }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 3500); }
function setView(next) {
  view = next; document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === next));
  render(); window.scrollTo({top:0,behavior:'instant'});
  if (['home','history','insights'].includes(next)) api('/api/records').then(latest=>{records=latest;if (view===next) render();}).catch(requestError);
}
function title(name, crumb) { $('#pageTitle').textContent = name; $('#breadcrumb').textContent = crumb; }
function personKey(record) { return JSON.stringify([record.name, record.code || '']); }
function people() { return [...new Map(records.map(record => [personKey(record), {key:personKey(record),name:record.name,code:record.code}])).values()].sort((a,b) => a.name.localeCompare(b.name,'zh-Hant')); }
function recordSet() { return records.filter(record => (!filterPerson || personKey(record) === filterPerson) && (filterTrack === 'all' || record.track === filterTrack)).sort((a,b) => a.finishedAt - b.finishedAt); }
function averages(list) { return list.length ? Math.round(list.reduce((sum,item) => sum + item.score,0) / list.length) : 0; }
function recentRecords(limit = 5) { return [...records].sort((a,b) => b.finishedAt - a.finishedAt).slice(0,limit); }
function topWeaknesses(list, limit = 5) {
  const tally = new Map();
  for (const record of list) for (const item of record.items) {
    const key = `${item.subject} / ${item.topic}`;
    const entry = tally.get(key) || {label:`${SUBJECTS[item.subject]?.name || item.subject} / ${item.topic}`,wrong:0,total:0};
    entry.total++; if (item.answer !== item.correct) entry.wrong++;
    tally.set(key,entry);
  }
  return [...tally.values()].filter(item => item.wrong).sort((a,b) => b.wrong/a.total - a.wrong/b.total || b.wrong-a.wrong).slice(0,limit);
}
function stat(label, value, note) { return `<div class="stat"><small>${label}</small><strong>${value}</strong><span>${note}</span></div>`; }
function historyTable(list) {
  if (!list.length) return '<div class="empty"><strong>還沒有測驗紀錄</strong>完成第一場模擬考後，成績就會出現在這裡。</div>';
  return `<div class="table-wrap"><table><thead><tr><th>考生</th><th>考試類別</th><th>完成時間</th><th>分數</th><th>狀態</th><th></th></tr></thead><tbody>${list.map(record => `<tr><td>${safe(record.name)}</td><td>${safe(TRACKS[record.track]?.name || record.track)}</td><td>${dateText(record.finishedAt)}</td><td class="score ${record.score >= 70 ? 'pass':''}">${record.score} 分</td><td><span class="pill ${record.score >= 70 ? 'pass':'fail'}">${record.score >= 70 ? '達標':'待加強'}</span></td><td><button class="text-button" data-review="${safe(record.id)}">查看</button></td></tr>`).join('')}</tbody></table></div>`;
}
function weaknessBars(list) {
  const weak = topWeaknesses(list);
  if (!weak.length) return '<div class="empty"><strong>尚無錯題資料</strong>完成模擬考後，可查看需要加強的主題。</div>';
  return `<div class="insight-list">${weak.map(item => `<div class="insight-row"><div class="insight-label"><strong>${safe(item.label)}</strong><span>${item.wrong} / ${item.total} 題錯誤</span></div><div class="bar low"><span style="width:${Math.round(item.wrong/item.total*100)}%"></span></div></div>`).join('')}</div>`;
}
function renderHome() {
  title('準備好，開始下一場練習','總覽 / 模擬測驗');
  const last = recentRecords(1)[0];
  $('#content').innerHTML = `${active ? `<div class="notice" style="margin-top:0">${safe(active.name)} 有一場尚未完成的 ${safe(TRACKS[active.track].name)}。<button class="text-button" data-view="exam">繼續作答 →</button></div>`:''}<section class="hero"><div class="hero-content"><span class="hero-label">IPAS AI APPLICATION PLANNER</span><h2>每一次練習，<br>都離目標更近一步。</h2><p>依官方評鑑範圍設計原創題庫。選擇初級或中級方向，完成 50 題模擬考，追蹤自己的進步與弱點。</p></div><div class="hero-art" aria-hidden="true">✦</div></section>
    <div class="grid-stats">${stat('題庫總量',BANK_SIZE+' 題','涵蓋 5 個考科')}${stat('已完成測驗',records.length+' 次','持續累積練習紀錄')}${stat('平均成績',averages(records)+' 分','所有考生的模擬考平均')}${stat('最近一次成績',last ? last.score+' 分':'—','每場滿分 100 分')}</div>
    <div class="section-head"><div><h2>選擇模擬考</h2><p>每場 50 題、90 分鐘；題目與選項順序會重新隨機安排。</p></div><button class="secondary-button" data-view="resume">跨裝置續考</button></div>
    <div class="track-grid">${Object.entries(TRACKS).map(([key,track],index) => `<article class="track-card"><div class="track-top"><span class="track-icon ${['blue','teal','purple'][index]}">${['◎','▥','◈'][index]}</span><span class="tag">${track.badge}</span></div><h3>${track.name}</h3><p>${track.subjects.map(subject => SUBJECTS[subject].name).join(' ＋ ')}</p><div class="track-meta"><span>◷ 90 分鐘</span><span>▦ 50 題</span><span>◎ 單選題</span></div><button class="primary-button" data-start="${key}">開始測驗　→</button></article>`).join('')}</div>
    <div class="below-grid"><section><div class="section-head"><div><h2>最近測驗</h2><p>回顧過去作答成果</p></div><button class="text-button" data-view="history">查看全部 →</button></div><div class="card">${historyTable(recentRecords())}</div></section><section><div class="section-head"><div><h2>常錯主題</h2><p>從錯誤率較高的主題開始複習</p></div></div><div class="card">${weaknessBars(records)}</div></section></div>`;
}
function renderStart(track) {
  if (active) { toast('你有一場尚未完成的測驗，請先繼續或交卷。'); setView('exam'); return; }
  const info = TRACKS[track];
  title('建立模擬測驗','總覽 / 考前準備');
  $('#content').innerHTML = `<div class="card" style="max-width:700px"><span class="eyebrow">${info.badge} / 50 QUESTIONS</span><h2 style="margin:10px 0 6px">${info.name}</h2><p class="muted">${info.subjects.map(subject => SUBJECTS[subject].name).join(' ＋ ')}</p><form id="startForm"><div class="form-grid" style="margin-top:25px"><label class="field">考生姓名<input id="nameInput" required maxlength="40" autocomplete="name" placeholder="請輸入姓名" /></label><label class="field">考生識別碼（選填）<input id="codeInput" maxlength="30" placeholder="同名考生可用學號或代碼區分" /></label></div><div class="notice">本模擬考固定 <strong>50 題、90 分鐘</strong>，每科各抽 25 題。交卷後顯示分數、錯誤主題及解析。初級官方單科考試為 75 分鐘；此處依你設定採 90 分鐘練習。姓名與紀錄保存在伺服器的 SQLite 資料庫，其他裝置連到同一伺服器也能查看。</div><div class="actions"><button class="primary-button" type="submit">開始 90 分鐘測驗 →</button><button class="secondary-button" type="button" data-view="home">返回總覽</button></div></form></div>`;
  $('#startForm').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('#nameInput').value.trim(); const code = $('#codeInput').value.trim();
    if (!name) { toast('請先輸入考生姓名。'); return; }
    const submit=$('#startForm button[type="submit"]'); submit.disabled=true;
    try {
      active=await api('/api/exams',{method:'POST',body:payload({name,code,track})});
      current=0; setView('exam');
    } catch (error) {
      if (error.status===409 && error.data.active) {
        active=error.data.active; current=0; setView('exam'); toast('已為這位考生接續未完成的測驗。');
      } else {requestError(error); submit.disabled=false;}
    }
  });
}
function renderResume() {
  title('繼續未完成測驗','總覽 / 跨裝置續考');
  $('#content').innerHTML=`<div class="card" style="max-width:700px"><h2>找回進行中的測驗</h2><p class="muted">輸入開始測驗時使用的姓名與識別碼。資料須連到同一台伺服器。</p><form id="resumeForm"><div class="form-grid" style="margin:24px 0"><label class="field">考生姓名<input id="resumeName" required maxlength="40" autocomplete="name" /></label><label class="field">考生識別碼（未設定請留白）<input id="resumeCode" maxlength="30" /></label></div><div class="actions"><button class="primary-button" type="submit">尋找並繼續作答 →</button><button class="secondary-button" type="button" data-view="home">返回總覽</button></div></form></div>`;
  $('#resumeForm').addEventListener('submit',async event=>{
    event.preventDefault(); const name=$('#resumeName').value.trim(),code=$('#resumeCode').value.trim();
    if (!name) return;
    const button=$('#resumeForm button[type="submit"]');button.disabled=true;
    try {
      const exam=await api(`/api/active?name=${encodeURIComponent(name)}&code=${encodeURIComponent(code)}`);
      if (!exam) {toast('找不到未完成的測驗。若已逾時，請到成績紀錄查看。');button.disabled=false;return;}
      active=exam;current=0;setView('exam');
    } catch(error) {requestError(error);button.disabled=false;}
  });
}
function remaining() { return active ? Math.max(0, DURATION - (Date.now() - active.startedAt)) : 0; }
function timerText(ms) { const seconds = Math.ceil(ms / 1000); return `${String(Math.floor(seconds/3600)).padStart(2,'0')}:${String(Math.floor(seconds%3600/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`; }
function updateTimer() {
  if (!active) return;
  const ms = remaining();
  const timer = view === 'exam' ? $('#timer') : null;
  if (timer) { timer.textContent = timerText(ms); timer.classList.toggle('urgent',ms < 5*60*1000); }
  if (ms <= 0 && Date.now()-lastFinishAttempt > 5000) finishExam();
}
function renderExam() {
  if (!active) { setView('home'); return; }
  if (remaining() <= 0) { finishExam(true); return; }
  title('模擬測驗進行中',`${TRACKS[active.track].name} / 第 ${current+1} 題`);
  const question = active.questions[current], answered = active.answers.filter(value => value !== null).length;
  $('#content').innerHTML = `<div class="exam-header"><div><strong>${safe(TRACKS[active.track].name)}</strong><div class="muted">考生：${safe(active.name)}${active.code ? ' · '+safe(active.code):''}　｜　已作答 ${answered} / 50</div></div><div class="timer" id="timer" aria-live="off">${timerText(remaining())}</div></div><div class="exam-layout"><section class="card question-card"><span class="question-meta">QUESTION ${String(current+1).padStart(2,'0')} / 50 · ${safe(SUBJECTS[question.subject].name)} · ${safe(question.topic)}</span><h2>${safe(question.prompt)}</h2><div class="choices">${question.options.map((option,index) => `<button class="choice ${active.answers[current] === index ? 'selected':''}" data-answer="${index}"><span class="choice-letter">${'ABCD'[index]}</span><span>${safe(option)}</span></button>`).join('')}</div><div class="exam-nav"><button class="secondary-button" data-prev ${current === 0 ? 'disabled':''}>← 上一題</button><div class="actions"><button class="secondary-button" data-clear ${active.answers[current] === null ? 'disabled':''}>清除答案</button>${current < 49 ? '<button class="primary-button" data-next>下一題 →</button>' : '<button class="primary-button" data-submit>完成交卷 →</button>'}</div></div></section><aside class="card"><strong style="font-size:13px">作答進度</strong><div class="progress-track"><span style="width:${answered*2}%"></span></div><div class="muted">已完成 ${answered} 題 · 尚未作答 ${50-answered} 題</div><div class="palette" aria-label="題目導覽">${active.questions.map((_,index) => `<button aria-label="第 ${index+1} 題${active.answers[index] !== null ? '，已作答':''}" class="${active.answers[index] !== null ? 'answered':''} ${current === index ? 'current':''}" data-jump="${index}">${index+1}</button>`).join('')}</div><button class="secondary-button" data-submit style="width:100%;margin-top:20px">提前交卷</button><button class="text-button" data-abandon style="width:100%;margin-top:9px">放棄這場測驗</button><p class="muted" style="line-height:1.6">時間到將自動交卷。離開頁面後重新開啟，仍可繼續未完成的測驗。</p></aside></div>`;
}
function acceptRecord(record) {
  if (!records.some(item=>item.id===record.id)) records.push(record);
  active=null; selectedRecord=record.id; setView('result');
  toast(record.expired ? '時間到，已自動交卷並保存成績。' : '交卷完成，成績已保存。');
}
async function finishExam() {
  if (!active || finishing || saving) return;
  finishing=true;lastFinishAttempt=Date.now();
  try { acceptRecord(await api(`/api/exams/${encodeURIComponent(active.id)}`,{method:'POST'})); }
  catch(error) {requestError(error);}
  finally {finishing=false;}
}
function renderResult() {
  const record = records.find(item => item.id === selectedRecord);
  if (!record) { setView('history'); return; }
  title('測驗結果與錯題解析',`${TRACKS[record.track].name} / 成績報告`);
  const wrong = record.items.filter(item => item.answer !== item.correct);
  $('#content').innerHTML = `<div class="result-hero"><div><span class="hero-label">EXAM REPORT</span><h2>${safe(record.name)}，${record.score >= 70 ? '這次達到練習目標！':'找出弱點，下一次會更好。'}</h2><p>${safe(TRACKS[record.track].name)} · ${dateText(record.finishedAt)}${record.expired ? ' · 時間到自動交卷':''}<br>答對 ${record.correct} 題 / 50 題，答錯或未作答 ${50-record.correct} 題。</p></div><div class="result-score">${record.score}<small> / 100</small></div></div><div class="result-grid"><section class="card"><div class="section-head"><div><h2>錯誤主題</h2><p>依本場測驗各主題錯誤比例排序</p></div></div>${weaknessBars([record])}</section><section class="card"><div class="section-head"><div><h2>下一步</h2><p>持續追蹤自己的成績曲線</p></div></div><p style="font-size:13px;line-height:1.8;color:#66778e">先複習下方錯題解析，再開始下一場不同題目的模擬考。進入「學習分析」可按姓名與考試類別查看歷次成績。</p><div class="actions"><button class="primary-button" data-view="home">再練習一場 →</button><button class="secondary-button" data-view="insights">查看成績曲線</button><button class="text-button" data-delete="${safe(record.id)}">刪除這筆紀錄</button></div></section></div><section class="card" style="margin-top:18px"><div class="section-head"><div><h2>錯題解析</h2><p>共 ${wrong.length} 題答錯或未作答</p></div></div>${wrong.length ? wrong.map(item => `<div class="review-item"><strong>${safe(item.prompt)}</strong><p class="wrong">你的答案：${item.answer === null ? '未作答' : safe(item.options[item.answer])}</p><p class="correct">正確答案：${safe(item.options[item.correct])}</p><p>解析：${safe(item.explanation)}</p></div>`).join('') : '<div class="empty"><strong>全部答對！</strong>這場測驗沒有錯題。</div>'}</section>`;
}
function renderHistory() {
  title('每場努力，都有紀錄','總覽 / 成績紀錄');
  const list = [...records].sort((a,b) => b.finishedAt-a.finishedAt);
  $('#content').innerHTML = `<div class="section-head"><div><h2>歷次測驗</h2><p>依完成時間排序，共 ${records.length} 場</p></div><button class="secondary-button" id="exportCsv" ${records.length ? '':'disabled'}>匯出 CSV</button></div><div class="card">${historyTable(list)}</div><p class="muted" style="margin-top:15px">成績保存在伺服器的 SQLite 資料庫。其他瀏覽器或電腦連到同一台伺服器，即可看到這些紀錄；CSV 可作為額外備份。</p>`;
  $('#exportCsv').addEventListener('click', exportCsv);
}
function lineChart(list) {
  if (!list.length) return '<div class="empty"><strong>還沒有足夠資料</strong>選擇考生並完成測驗後，這裡會顯示成績曲線。</div>';
  const width=680,height=230,padL=36,padR=16,padT=18,padB=33;
  const x = index => list.length === 1 ? (padL+width-padR)/2 : padL+(width-padL-padR)*index/(list.length-1);
  const y = score => padT+(height-padT-padB)*(1-score/100);
  const line = list.map((record,index) => `${index ? 'L':'M'}${x(index)},${y(record.score)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="依時間排序的成績曲線"><line x1="${padL}" y1="${y(70)}" x2="${width-padR}" y2="${y(70)}" stroke="#9ed9c9" stroke-dasharray="5 5"/><text x="2" y="${y(70)+4}" font-size="10" fill="#7f96a9">70</text>${[0,50,100].map(score => `<line x1="${padL}" y1="${y(score)}" x2="${width-padR}" y2="${y(score)}" stroke="#edf1f7"/><text x="4" y="${y(score)+4}" font-size="10" fill="#9caaba">${score}</text>`).join('')}<path d="${line}" fill="none" stroke="#3973ea" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${list.map((record,index) => `<circle cx="${x(index)}" cy="${y(record.score)}" r="5" fill="#3973ea" stroke="white" stroke-width="2"><title>${dateText(record.finishedAt)}：${record.score} 分</title></circle><text x="${x(index)}" y="${y(record.score)-12}" text-anchor="middle" font-size="11" font-weight="700" fill="#345caa">${record.score}</text>`).join('')}<text x="${padL}" y="${height-4}" font-size="10" fill="#9caaba">首次</text><text x="${width-padR}" y="${height-4}" font-size="10" fill="#9caaba" text-anchor="end">最近</text></svg>`;
}
function renderInsights() {
  title('看見自己的進步曲線','總覽 / 學習分析');
  const persons=people(); if (filterPerson === null && persons.length) filterPerson=persons[0].key;
  const list=recordSet(); const latest=list[list.length-1];
  $('#content').innerHTML = `<div class="filter-row"><label class="field">考生姓名<select id="filterName"><option value="">所有考生</option>${persons.map(person => `<option value="${safe(person.key)}" ${filterPerson === person.key ? 'selected':''}>${safe(person.name)}${person.code ? ' · '+safe(person.code):''}</option>`).join('')}</select></label><label class="field">考試類別<select id="filterTrack"><option value="all">全部類別</option>${Object.entries(TRACKS).map(([key,track]) => `<option value="${key}" ${filterTrack === key ? 'selected':''}>${track.name}</option>`).join('')}</select></label></div><div class="grid-stats" style="margin-top:0">${stat('測驗次數',list.length+' 次','目前篩選條件')}${stat('平均成績',averages(list)+' 分','歷次測驗平均')}${stat('最佳成績',list.length ? Math.max(...list.map(item => item.score))+' 分':'—','個人最高紀錄')}${stat('最近成績',latest ? latest.score+' 分':'—','持續練習觀察變化')}</div><div class="result-grid"><section class="card"><div class="section-head"><div><h2>成績曲線</h2><p>由左至右依完成日期排列，虛線為 70 分練習目標</p></div></div>${lineChart(list)}</section><section class="card"><div class="section-head"><div><h2>常錯主題</h2><p>彙整篩選範圍內的錯題</p></div></div>${weaknessBars(list)}</section></div><section class="card" style="margin-top:18px"><div class="section-head"><div><h2>測驗明細</h2><p>點選「查看」可回顧錯題</p></div></div>${historyTable([...list].reverse())}</section>`;
  $('#filterName').addEventListener('change',event => {filterPerson=event.target.value;renderInsights();});
  $('#filterTrack').addEventListener('change',event => {filterTrack=event.target.value;renderInsights();});
}
function renderBank() {
  title('完整覆蓋五大考科','總覽 / 題庫範圍');
  $('#content').innerHTML = `<div class="hero"><div class="hero-content"><span class="hero-label">ORIGINAL PRACTICE BANK</span><h2>${BANK_SIZE} 題原創練習題</h2><p>依 115 年度 iPAS AI 應用規劃師官方評鑑主題編寫。每個知識點包含兩種問法，單場測驗不會抽到同一概念的兩種問法。</p></div><div class="hero-art" aria-hidden="true">▦</div></div><div class="bank-table" style="margin-top:20px">${Object.entries(SUBJECTS).map(([key,subject]) => {
    const topics=[...new Set(BANK[key].map(item => item.topic))];
    return `<article class="bank-tile" style="background:white"><span class="tag">${subject.level}</span><h3 style="margin-top:12px">${subject.name}</h3><p>${BANK[key].length} 題 · ${topics.map(safe).join('、')}</p></article>`;
  }).join('')}</div><p class="muted" style="line-height:1.8;margin-top:16px">題目為本站原創模擬練習，非官方歷屆試題。評鑑範圍參考 <a href="https://www.ipas.org.tw/api/proxy/uploads/certification/AIAP/115%E5%B9%B4%E5%BA%A6AI%E6%87%89%E7%94%A8%E8%A6%8F%E5%8A%83%E5%B8%AB%E8%83%BD%E5%8A%9B%E9%91%91%E5%AE%9A%E7%B0%A1%E7%AB%A0%28%E5%88%9D%E3%80%81%E4%B8%AD%E7%B4%9A%29_20251225235744.pdf" target="_blank" rel="noopener">官方 115 年度簡章</a>。</p>`;
}
function exportCsv() {
  const rows=[['姓名','識別碼','考試類別','開始時間','完成時間','分數','答對題數','是否逾時'],...records.map(record => [record.name,record.code,TRACKS[record.track]?.name, dateText(record.startedAt),dateText(record.finishedAt),record.score,record.correct,record.expired?'是':'否'])];
  const csv='\ufeff'+rows.map(row => row.map(value => '"'+String(value ?? '').replace(/"/g,'""')+'"').join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})); const link=document.createElement('a'); link.href=url; link.download='ipas-ai-exam-results.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
function render() {
  if (view === 'home') renderHome(); else if (view === 'start') renderStart(window.pendingTrack || 'basic'); else if (view === 'resume') renderResume();
  else if (view === 'exam') renderExam(); else if (view === 'result') renderResult();
  else if (view === 'history') renderHistory(); else if (view === 'insights') renderInsights(); else renderBank();
}
document.addEventListener('click',async event => {
  const button=event.target.closest('button'); if (!button) return;
  if (button.dataset.start) {window.pendingTrack=button.dataset.start;setView('start');return;}
  if (button.dataset.view) {setView(button.dataset.view);return;}
  if (button.dataset.review) {selectedRecord=button.dataset.review;setView('result');return;}
  if (button.dataset.delete) {
    if (!confirm('確定刪除這筆測驗紀錄嗎？刪除後無法復原。')) return;
    try {await api(`/api/records/${encodeURIComponent(button.dataset.delete)}`,{method:'DELETE'});
      records=records.filter(item=>item.id!==button.dataset.delete);selectedRecord=null;setView('history');toast('已刪除測驗紀錄。');}
    catch(error) {requestError(error);} return;
  }
  if (view !== 'exam' || !active) return;
  if (button.dataset.answer !== undefined || button.hasAttribute('data-clear')) {
    if (saving || finishing) return;
    const index=current,answer=button.hasAttribute('data-clear') ? null : Number(button.dataset.answer);
    const prior=active.answers[index];active.answers[index]=answer;renderExam();saving=true;
    try {await api(`/api/exams/${encodeURIComponent(active.id)}/answers`,{method:'PATCH',body:payload({index,answer})});}
    catch(error) {
      if (error.status===409 && error.data.record) acceptRecord(error.data.record);
      else {if (active) {active.answers[index]=prior;renderExam();}requestError(error);}
    } finally {saving=false;} return;
  }
  if (button.hasAttribute('data-prev')) {current=Math.max(0,current-1);renderExam();return;}
  if (button.hasAttribute('data-next')) {current=Math.min(49,current+1);renderExam();return;}
  if (button.dataset.jump !== undefined) {current=Number(button.dataset.jump);renderExam();return;}
  if (button.hasAttribute('data-submit')) {const missing=active.answers.filter(value => value === null).length; if (missing && !confirm(`還有 ${missing} 題未作答，確定交卷嗎？`)) return;await finishExam();return;}
  if (button.hasAttribute('data-abandon')) {
    if (!confirm('確定放棄這場測驗嗎？這場作答不會列入成績。')) return;
    try {await api(`/api/exams/${encodeURIComponent(active.id)}`,{method:'DELETE'});active=null;setView('home');toast('已放棄測驗。');}
    catch(error) {requestError(error);} return;
  }
});
$('#today').textContent=new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'long',day:'numeric'}).format(new Date());
setInterval(updateTimer,1000);
async function bootstrap() {
  try {
    let legacyRecords=[],legacyActive=null;
    try {legacyRecords=JSON.parse(localStorage.getItem(LEGACY_RECORD_KEY)||'[]');legacyActive=JSON.parse(localStorage.getItem(LEGACY_EXAM_KEY)||'null');} catch {}
    if (legacyRecords.length || legacyActive) {
      const imported=await api('/api/import',{method:'POST',body:payload({records:legacyRecords,active:legacyActive})});
      try {localStorage.removeItem(LEGACY_RECORD_KEY);localStorage.removeItem(LEGACY_EXAM_KEY);} catch {}
      active=imported.active;
      if (active) {view='exam';document.querySelectorAll('.nav-item').forEach(el=>el.classList.remove('active'));}
    }
    records=await api('/api/records');render();
  } catch(error) {
    $('#content').innerHTML=`<div class="card"><h2>無法載入考試系統</h2><p>請確認 Node 伺服器正在運作，且 SQLite 資料庫可寫入。</p><p class="muted">${safe(error.message)}</p><button class="primary-button" onclick="location.reload()">重新載入</button></div>`;
  }
}
bootstrap();
