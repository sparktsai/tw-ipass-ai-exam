import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

async function start(dbPath) {
  const app=await createApp({dbPath});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  return {...app,base,async close() {await new Promise(resolve=>app.server.close(resolve));app.db.close();}};
}
async function call(base,path,method='GET',data) {
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined ? undefined : JSON.stringify(data)});
  return {status:response.status,data:await response.json()};
}

test('SQLite keeps answers and grades across server restarts and independent clients',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ipas-ai-test-'));
  const dbPath=join(directory,'exam.sqlite');
  let app;
  try {
    app=await start(dbPath);
    const created=await call(app.base,'/api/exams','POST',{name:'測試考生',code:'A-1',track:'basic'});
    assert.equal(created.status,201);
    const exam=created.data;
    assert.equal(exam.questions.length,50);
    assert.equal(exam.answers.length,50);
    const answer=await call(app.base,`/api/exams/${exam.id}/answers`,'PATCH',{index:0,answer:exam.questions[0].correct});
    assert.equal(answer.status,200);
    await app.close();

    app=await start(dbPath);
    const resumed=await call(app.base,'/api/active?name=%E6%B8%AC%E8%A9%A6%E8%80%83%E7%94%9F&code=A-1');
    assert.equal(resumed.data.id,exam.id);
    assert.equal(resumed.data.answers[0],exam.questions[0].correct);
    const finished=await call(app.base,`/api/exams/${exam.id}`,'POST');
    assert.equal(finished.status,200);
    assert.equal(finished.data.score,2);
    assert.equal(finished.data.correct,1);
    await app.close();

    app=await start(dbPath);
    const history=await call(app.base,'/api/records');
    assert.equal(history.data.length,1);
    assert.equal(history.data[0].name,'測試考生');
    assert.equal(history.data[0].score,2);
    assert.equal(history.data[0].items.length,50);
    const samePerson=await call(app.base,'/api/active?name=%E6%B8%AC%E8%A9%A6%E8%80%83%E7%94%9F&code=A-1');
    assert.equal(samePerson.data,null);
  } finally {
    if (app?.server.listening) await app.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('legacy browser records can be imported only once',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ipas-ai-import-'));
  const dbPath=join(directory,'exam.sqlite');
  const app=await start(dbPath);
  try {
    const started=await call(app.base,'/api/exams','POST',{name:'舊資料',code:'',track:'ml'});
    const exam=started.data;
    const items=exam.questions.map((question,index)=>({...question,answer:index===0 ? question.correct : null}));
    const record={id:'legacy-record-1',name:'舊資料',code:'',track:'ml',startedAt:1000,finishedAt:2000,items};
    for (let i=0;i<2;i++) assert.equal((await call(app.base,'/api/import','POST',{records:[record],active:null})).status,200);
    const history=await call(app.base,'/api/records');
    assert.equal(history.data.length,1);
    assert.equal(history.data[0].score,2);
  } finally {
    await app.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('expired attempts are graded after the server comes back online',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ipas-ai-expire-'));
  const dbPath=join(directory,'exam.sqlite');
  let app;
  try {
    app=await start(dbPath);
    const exam=(await call(app.base,'/api/exams','POST',{name:'逾時考生',track:'data'})).data;
    app.db.prepare('UPDATE attempts SET started_at=? WHERE id=?').run(Date.now()-91*60*1000,exam.id);
    await app.close();
    app=await start(dbPath);
    const records=(await call(app.base,'/api/records')).data;
    assert.equal(records.length,1);
    assert.equal(records[0].expired,true);
    assert.equal(records[0].score,0);
  } finally {
    if (app?.server.listening) await app.close();
    await rm(directory,{recursive:true,force:true});
  }
});
