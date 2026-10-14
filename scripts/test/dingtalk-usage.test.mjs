import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageLedger } from '../dingtalk-jobs.mjs';
import { buildUsageSnapshot } from '../publish-dingtalk-usage.mjs';

test('统计真实启动次数、剩余额度和最近调用；不公开会话、模型或提示词', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'jqz-usage-test-'));
  try {
    let now=Date.parse('2026-10-14T14:00:00Z');
    const ledger=new UsageLedger(path.join(directory,'usage.jsonl'),'private-scope',{now:()=>now});
    const first=ledger.start('private-job',{model:'private-model'});
    ledger.append({event:'finished',callId:first,success:false,errorCode:'MODEL_TIMEOUT'});
    let snapshot=buildUsageSnapshot(ledger,200,now);
    assert.equal(snapshot.used,1);assert.equal(snapshot.remaining,199);assert.equal(snapshot.latestStatus,'timeout');
    now+=60000;const second=ledger.start('another-private-job');
    snapshot=buildUsageSnapshot(ledger,200,now);assert.equal(snapshot.used,2);assert.equal(snapshot.latestStatus,'running');
    ledger.append({event:'finished',callId:second,success:true});
    snapshot=buildUsageSnapshot(ledger,200,now);assert.equal(snapshot.latestStatus,'success');
    assert.doesNotMatch(JSON.stringify(snapshot),/private-|callId|jobId|scopeHash|model|token/i);
    now=Date.parse('2026-10-14T16:01:00Z');snapshot=buildUsageSnapshot(ledger,200,now);
    assert.equal(snapshot.date,'2026-10-15');assert.equal(snapshot.used,0);assert.equal(snapshot.remaining,200);
    assert.equal(snapshot.latestAt,new Date(Date.parse('2026-10-14T14:01:00Z')).toISOString());
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('减少额度不会产生负剩余次数，未有调用时显示空最新状态',()=>{
 const ledger={stats:()=>({date:'2026-10-14',calls:5}),calls:new Map()};
 const snapshot=buildUsageSnapshot(ledger,2);assert.equal(snapshot.remaining,0);assert.equal(snapshot.latestAt,null);assert.equal(snapshot.latestStatus,null);
 assert.throws(()=>buildUsageSnapshot(ledger,0));
});

test('独立统计按实际额度公开必要字段，先上传再提交，状态变化后再次发布',async()=>{
 const {publishUsage}=await import('../publish-dingtalk-usage.mjs');
 const {digest}=await import('../dingtalk-jobs.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jqz-usage-publish-'));
 try {
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  const raw=path.join(root,'raw.json'),summary=path.join(root,'summary.json'),key=path.join(root,'key'),captured=path.join(root,'captured.json'),calls=path.join(root,'calls');
  fs.writeFileSync(raw,JSON.stringify({conversationId:'fixture-conversation'}));fs.writeFileSync(key,'fixture');
  const ledger=new UsageLedger(summary+'.usage.jsonl',digest('fixture-conversation'),{callBudget:200});const call=ledger.start('private-job');
  fs.writeFileSync(path.join(bin,'scp'),"#!/usr/bin/env node\nrequire('node:fs').copyFileSync(process.argv.at(-2),process.env.TEST_CAPTURED);\n",{mode:0o700});
  fs.writeFileSync(path.join(bin,'ssh'),"#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.TEST_CALLS,process.argv.at(-1)+'\\n');\n",{mode:0o700});
  const env={...process.env,PATH:bin+':'+process.env.PATH,DINGTALK_LOCAL_SNAPSHOT_FILE:raw,DINGTALK_LOCAL_SUMMARY_FILE:summary,DINGTALK_CONVERSATION_ID:'fixture-conversation',DINGTALK_DAILY_CALL_BUDGET:'200',DINGTALK_PUSH_HOST:'fixture.invalid',DINGTALK_PUSH_SSH_KEY:key,TEST_CAPTURED:captured,TEST_CALLS:calls};
  const a=await publishUsage(env);assert.equal(a.used,1);assert.equal(a.remaining,199);assert.equal(a.latestStatus,'running');
  assert.match(fs.readFileSync(calls,'utf8'),/chmod 0644.*mv -f/,'静态统计文件需要能由Nginx读取');
  assert.doesNotMatch(fs.readFileSync(captured,'utf8'),/private-job|fixture-conversation|key|scopeHash/);
  const unchanged=await publishUsage(env);assert.equal(unchanged,undefined);
  ledger.append({event:'finished',callId:call,success:true});
  const b=await publishUsage(env);assert.equal(b.latestStatus,'success');assert.equal(b.used,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('真实账本缺失时拒绝发布，不把缺失数据显示为零调用',async()=>{
 const {publishUsage}=await import('../publish-dingtalk-usage.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jqz-usage-missing-'));
 try {
  const raw=path.join(root,'raw.json');fs.writeFileSync(raw,JSON.stringify({conversationId:'fixture-conversation'}));
  const env={...process.env,DINGTALK_LOCAL_SNAPSHOT_FILE:raw,DINGTALK_LOCAL_SUMMARY_FILE:path.join(root,'missing-summary'),DINGTALK_CONVERSATION_ID:'fixture-conversation',DINGTALK_DAILY_CALL_BUDGET:'200',DINGTALK_USAGE_PUBLISH_ONLY:'1'};
  await assert.rejects(publishUsage(env),error=>error.code==='ENOENT');
  assert.equal(fs.existsSync(path.join(root,'missing-summary.usage-published.json')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
