import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TRACKS, makeExam } from './questions.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(process.env.DB_PATH || resolve(ROOT, 'data', 'ipas-ai.sqlite'));
const DURATION = 90 * 60 * 1000;
const MAX_BODY = 6 * 1024 * 1024;
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/questions.js': ['questions.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
function json(response, status, data) {
  response.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  response.end(JSON.stringify(data));
}
async function body(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY) throw httpError(413, '資料量過大');
  }
  try { return JSON.parse(raw || '{}'); } catch { throw httpError(400, 'JSON 格式不正確'); }
}
const parse = value => JSON.parse(value);
function examFromRow(row) {
  return {id:row.id,name:row.name,code:row.code,track:row.track,startedAt:row.started_at,
    questions:parse(row.questions_json),answers:parse(row.answers_json)};
}
function recordFromRow(row) {
  const questions=parse(row.questions_json), answers=parse(row.answers_json);
  return {id:row.id,name:row.name,code:row.code,track:row.track,startedAt:row.started_at,
    finishedAt:row.finished_at,score:row.score,correct:row.correct_count,expired:!!row.expired,
    items:questions.map((question,index) => ({...question,answer:answers[index]}))};
}
function validateName(value) {
  const name=String(value ?? '').trim();
  if (!name || name.length > 40) throw httpError(400, '請輸入 1 至 40 字的考生姓名');
  return name;
}
function validateCode(value) {
  const code=String(value ?? '').trim();
  if (code.length > 30) throw httpError(400, '識別碼最多 30 字');
  return code;
}
function validateTrack(value) {
  if (!Object.hasOwn(TRACKS,value)) throw httpError(400, '考試類別不正確');
  return value;
}
function validateQuestions(value) {
  if (!Array.isArray(value) || value.length !== 50 || value.some(question => !question ||
    typeof question.prompt !== 'string' || !Array.isArray(question.options) || question.options.length !== 4 ||
    !Number.isInteger(question.correct) || question.correct < 0 || question.correct > 3 ||
    typeof question.subject !== 'string' || typeof question.topic !== 'string')) throw httpError(400, '題目資料不正確');
  return value;
}
function validateAnswers(value) {
  if (!Array.isArray(value) || value.length !== 50 || value.some(answer => answer !== null &&
    (!Number.isInteger(answer) || answer < 0 || answer > 3))) throw httpError(400, '答案資料不正確');
  return value;
}
function finalize(db, row, now=Date.now()) {
  const questions=parse(row.questions_json), answers=parse(row.answers_json);
  const correct=questions.reduce((count,question,index) => count + Number(answers[index] === question.correct),0);
  const expired=now >= row.started_at+DURATION;
  const finishedAt=expired ? row.started_at+DURATION : now;
  db.prepare(`UPDATE attempts SET status='finished', finished_at=?, score=?, correct_count=?, expired=? WHERE id=? AND status='active'`)
    .run(finishedAt,correct*2,correct,Number(expired),row.id);
  return recordFromRow(db.prepare('SELECT * FROM attempts WHERE id=?').get(row.id));
}
function expireDue(db) {
  const due=db.prepare("SELECT * FROM attempts WHERE status='active' AND started_at <= ?").all(Date.now()-DURATION);
  for (const row of due) finalize(db,row);
}
function activeFor(db,name,code) {
  return db.prepare("SELECT * FROM attempts WHERE name=? AND code=? AND status='active' ORDER BY started_at DESC LIMIT 1").get(name,code);
}

export async function createApp({dbPath=DB_PATH}={}) {
  await mkdir(dirname(dbPath),{recursive:true});
  const db=new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=DELETE;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      track TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','finished','abandoned')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      score INTEGER,
      correct_count INTEGER,
      expired INTEGER NOT NULL DEFAULT 0,
      questions_json TEXT NOT NULL,
      answers_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_person ON attempts(name,code,finished_at);
    CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status,started_at);`);
  const insert=db.prepare(`INSERT INTO attempts
    (id,name,code,track,status,started_at,finished_at,score,correct_count,expired,questions_json,answers_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  const server=createServer(async (request,response) => {
    try {
      const url=new URL(request.url,'http://localhost');
      const path=url.pathname;
      if (path.startsWith('/api/')) {
        expireDue(db);
        if (request.method==='GET' && path==='/api/health') return json(response,200,{ok:true,storage:'sqlite'});
        if (request.method==='GET' && path==='/api/records') {
          const rows=db.prepare("SELECT * FROM attempts WHERE status='finished' ORDER BY finished_at ASC").all();
          return json(response,200,rows.map(recordFromRow));
        }
        if (request.method==='GET' && path==='/api/active') {
          const name=validateName(url.searchParams.get('name')),code=validateCode(url.searchParams.get('code'));
          const row=activeFor(db,name,code);
          return json(response,200,row ? examFromRow(row) : null);
        }
        if (request.method==='POST' && path==='/api/exams') {
          const input=await body(request),name=validateName(input.name),code=validateCode(input.code),track=validateTrack(input.track);
          const prior=activeFor(db,name,code);
          if (prior) return json(response,409,{message:'此考生已有未完成的測驗',active:examFromRow(prior)});
          const exam={id:crypto.randomUUID(),name,code,track,startedAt:Date.now(),questions:makeExam(track),answers:Array(50).fill(null)};
          insert.run(exam.id,name,code,track,'active',exam.startedAt,null,null,null,0,JSON.stringify(exam.questions),JSON.stringify(exam.answers));
          return json(response,201,exam);
        }
        const answerMatch=path.match(/^\/api\/exams\/([^/]+)\/answers$/);
        if (request.method==='PATCH' && answerMatch) {
          const row=db.prepare('SELECT * FROM attempts WHERE id=?').get(answerMatch[1]);
          if (!row || row.status!=='active') throw httpError(404,'找不到進行中的測驗');
          if (Date.now() >= row.started_at+DURATION) return json(response,409,{message:'測驗時間已到',record:finalize(db,row)});
          const input=await body(request), index=input.index, answer=input.answer;
          if (!Number.isInteger(index) || index<0 || index>=50 || (answer!==null && (!Number.isInteger(answer)||answer<0||answer>3))) throw httpError(400,'答案格式不正確');
          const answers=parse(row.answers_json); answers[index]=answer;
          db.prepare("UPDATE attempts SET answers_json=? WHERE id=? AND status='active'").run(JSON.stringify(answers),row.id);
          return json(response,200,{ok:true,answers});
        }
        const examMatch=path.match(/^\/api\/exams\/([^/]+)$/);
        if (examMatch && request.method==='POST') {
          const row=db.prepare('SELECT * FROM attempts WHERE id=?').get(examMatch[1]);
          if (!row || row.status==='abandoned') throw httpError(404,'找不到測驗');
          return json(response,200,row.status==='finished' ? recordFromRow(row) : finalize(db,row));
        }
        if (examMatch && request.method==='DELETE') {
          db.prepare("UPDATE attempts SET status='abandoned' WHERE id=? AND status='active'").run(examMatch[1]);
          return json(response,200,{ok:true});
        }
        const recordMatch=path.match(/^\/api\/records\/([^/]+)$/);
        if (recordMatch && request.method==='DELETE') {
          const result=db.prepare("DELETE FROM attempts WHERE id=? AND status='finished'").run(recordMatch[1]);
          if (!result.changes) throw httpError(404,'找不到成績紀錄');
          return json(response,200,{ok:true});
        }
        if (request.method==='POST' && path==='/api/import') {
          const input=await body(request);
          if (!Array.isArray(input.records) || input.records.length>1000) throw httpError(400,'匯入紀錄格式不正確');
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const record of input.records) {
              if (typeof record.id!=='string' || !record.id || db.prepare('SELECT id FROM attempts WHERE id=?').get(record.id)) continue;
              const name=validateName(record.name),code=validateCode(record.code),track=validateTrack(record.track);
              const questions=validateQuestions(record.items),answers=validateAnswers(record.items.map(item=>item.answer));
              const startedAt=Number(record.startedAt),finishedAt=Number(record.finishedAt);
              if (!Number.isFinite(startedAt)||!Number.isFinite(finishedAt)) throw httpError(400,'紀錄日期不正確');
              const correct=questions.reduce((count,item,index)=>count+Number(answers[index]===item.correct),0);
              insert.run(record.id,name,code,track,'finished',startedAt,finishedAt,correct*2,correct,Number(!!record.expired),
                JSON.stringify(questions.map(({answer,...question})=>question)),JSON.stringify(answers));
            }
            let importedActive=null;
            const prior=input.active;
            if (prior && typeof prior.id==='string' && !db.prepare('SELECT id FROM attempts WHERE id=?').get(prior.id)) {
              const name=validateName(prior.name),code=validateCode(prior.code),track=validateTrack(prior.track);
              if (!activeFor(db,name,code)) {
                const questions=validateQuestions(prior.questions),answers=validateAnswers(prior.answers),startedAt=Number(prior.startedAt);
                if (!Number.isFinite(startedAt)) throw httpError(400,'測驗日期不正確');
                insert.run(prior.id,name,code,track,'active',startedAt,null,null,null,0,JSON.stringify(questions),JSON.stringify(answers));
                importedActive=examFromRow(db.prepare('SELECT * FROM attempts WHERE id=?').get(prior.id));
              }
            }
            db.exec('COMMIT'); expireDue(db);
            return json(response,200,{ok:true,active:importedActive && db.prepare("SELECT * FROM attempts WHERE id=? AND status='active'").get(importedActive.id) ? importedActive : null});
          } catch (error) { db.exec('ROLLBACK'); throw error; }
        }
        throw httpError(404,'找不到 API');
      }
      const asset=ASSETS[path];
      if (request.method!=='GET' || !asset) throw httpError(404,'找不到頁面');
      const bytes=readFileSync(resolve(ROOT,asset[0]));
      response.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-cache'}); response.end(bytes);
    } catch (error) {
      if (!response.headersSent) json(response,error.status || 500,{message:error.status ? error.message : '伺服器發生錯誤'});
      if (!error.status) console.error(error);
    }
  });
  return {server,db,dbPath};
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {server,dbPath}=await createApp();
  const port=Number(process.env.PORT || 8765), host=process.env.HOST || '127.0.0.1';
  server.listen(port,host,()=>console.log(`iPAS AI 模擬考：http://${host}:${port}/\nSQLite：${dbPath}`));
}
