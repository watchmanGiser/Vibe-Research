import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
const script=new URL('../push-dingtalk-group.mjs',import.meta.url).pathname;
const hash=s=>createHash('sha256').update(s).digest('hex');
test('研报图片保留原页来源和英文识别结果；拒绝机械待核验及伪造来源字段',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jqz-research-'));
 try {
  const bin=path.join(root,'bin'),media=path.join(root,'media');fs.mkdirSync(bin);fs.mkdirSync(media);
  const key=path.join(root,'key'),captured=path.join(root,'published.json'),raw=path.join(root,'raw.json'),cache=path.join(root,'cache.json');fs.writeFileSync(key,'fixture-key');
  const text='大摩OCP研报[图片消息](mediaId=@research-page)';
  fs.writeFileSync(raw,JSON.stringify({conversationId:'report-test',syncedAt:'2026-10-14T00:00:00Z',duplicateCount:0,messages:[{messageId:'report-message',sender:'fixture',time:'2026-10-13T15:17:45Z',text,duplicateCount:0}]}));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const name=hash(png)+'.png';fs.writeFileSync(path.join(media,name),png);fs.writeFileSync(path.join(media,'index.json'),JSON.stringify({schemaVersion:1,conversationHash:hash('report-test'),files:{[hash('@research-page')]:name}}));
  fs.writeFileSync(path.join(bin,'gpt'),`#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);if(!args.includes('--image'))process.exit(8);
const report={publisher:'摩根士丹利',title:'Takeaways from 2026 OCP Global Summit',originalText:'We believe pioneer R&D progress could help gain market share. We expect commercial production to start from 2028 onwards.'};
if(process.env.TEST_EXTRA)report.privateToken='forbidden';
const v={kind:'research',title:'大摩OCP要点',summary:process.env.TEST_BOILERPLATE?'事实性陈述（待核验）：单模块400W。':'大摩认为先发布局可能提高份额，并预计2028年商业化。',keyPoints:['报告介绍12.8T方案和最高400W模块功耗。'],caveats:[],report};
fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(v));
`,{mode:0o700});
  fs.writeFileSync(path.join(bin,'scp'),"#!/usr/bin/env node\nrequire('node:fs').copyFileSync(process.argv.at(-2),process.env.TEST_CAPTURED);\n",{mode:0o700});fs.writeFileSync(path.join(bin,'ssh'),'#!/usr/bin/env node\n',{mode:0o700});
  const env={...process.env,PATH:bin+':'+process.env.PATH,DINGTALK_USE_ARCHIVE:'1',DINGTALK_GPT_PROVIDER_APPROVED:'1',DINGTALK_GPT_BIN:path.join(bin,'gpt'),DWS_BIN:'/bin/false',DINGTALK_CONVERSATION_ID:'report-test',DINGTALK_LOCAL_SNAPSHOT_FILE:raw,DINGTALK_LOCAL_SUMMARY_FILE:cache,DINGTALK_MEDIA_CACHE_DIR:media,DINGTALK_PUSH_HOST:'fixture.invalid',DINGTALK_PUSH_USER:'ubuntu',DINGTALK_PUSH_SSH_KEY:key,TEST_CAPTURED:captured};
  const run=extra=>spawnSync(process.execPath,[script],{env:{...env,...extra},encoding:'utf8'});
  let result=run();assert.equal(result.status,0,result.stderr);const pub=JSON.parse(fs.readFileSync(captured,'utf8'));assert.equal(pub.opinions[0].kind,'research');assert.match(pub.opinions[0].report.originalText,/We expect.*2028/);assert.equal(pub.opinions[0].report.publisher,'摩根士丹利');assert.doesNotMatch(fs.readFileSync(captured,'utf8'),/待核验|inputHash|textHash|report-message|@research-page/);
  const before=fs.readFileSync(captured,'utf8');
  for(const extra of [{TEST_BOILERPLATE:'1'},{TEST_EXTRA:'1'}]) {fs.rmSync(cache,{force:true});result=run(extra);assert.notEqual(result.status,0);assert.equal(fs.readFileSync(captured,'utf8'),before);}
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
