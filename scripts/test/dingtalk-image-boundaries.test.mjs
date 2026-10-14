import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const hash = value => createHash('sha256').update(value).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const script = new URL('../push-dingtalk-group.mjs', import.meta.url).pathname;
function fixture(check) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jqz-image-boundary-'));
  try {
    const bin=path.join(root,'bin'),media=path.join(root,'media');fs.mkdirSync(bin);fs.mkdirSync(media);
    const published=path.join(root,'published.json'),key=path.join(root,'key'),uploads=path.join(root,'uploads');fs.writeFileSync(key,'fixture-key');
    fs.writeFileSync(path.join(bin,'gpt'),`#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2);const image=a[a.indexOf('--image')+1];
fs.writeFileSync(a[a.indexOf('-o')+1],JSON.stringify({kind:'event',title:'图片通知',summary:'通知计划自2027年1月1日起调整指定产品。'+require('node:path').basename(image).slice(0,8),keyPoints:['按图片所载条件记录。'],caveats:[]}));
`,{mode:0o700});
    fs.writeFileSync(path.join(bin,'scp'),"#!/usr/bin/env node\nconst fs=require('node:fs');fs.copyFileSync(process.argv.at(-2),process.env.TEST_PUBLISHED);fs.appendFileSync(process.env.TEST_UPLOADS,'upload\\n');\n",{mode:0o700});
    fs.writeFileSync(path.join(bin,'ssh'),'#!/usr/bin/env node\n',{mode:0o700});
    const raw=path.join(root,'raw.json'),cache=path.join(root,'cache.json');
    fs.writeFileSync(raw,JSON.stringify({conversationId:'boundary-test',syncedAt:'2026-10-13T13:00:00Z',duplicateCount:0,messages:[
      {messageId:'notice-a',sender:'fixture',time:'2026-10-13T12:00:00Z',text:'供应商甲通知[图片消息](mediaId=@image-a)',duplicateCount:0},
      {messageId:'notice-b',sender:'fixture',time:'2026-10-13T11:00:00Z',text:'供应商乙停产[图片消息](mediaId=@image-b)',duplicateCount:0}
    ]}));
    const files={};
    const image=(ref,label)=>{const bytes=Buffer.concat([png,Buffer.from(label)]),name=hash(bytes)+'.png';fs.writeFileSync(path.join(media,name),bytes);files[hash(ref)]=name;fs.writeFileSync(path.join(media,'index.json'),JSON.stringify({schemaVersion:1,conversationHash:hash('boundary-test'),files}));return path.join(media,name);};
    const env={...process.env,PATH:bin+':'+process.env.PATH,DINGTALK_GPT_BIN:path.join(bin,'gpt'),DWS_BIN:'/bin/false',DINGTALK_USE_ARCHIVE:'1',DINGTALK_GPT_PROVIDER_APPROVED:'1',DINGTALK_CONVERSATION_ID:'boundary-test',DINGTALK_PUSH_HOST:'fixture.invalid',DINGTALK_PUSH_USER:'ubuntu',DINGTALK_PUSH_SSH_KEY:key,DINGTALK_LOCAL_SNAPSHOT_FILE:raw,DINGTALK_LOCAL_SUMMARY_FILE:cache,DINGTALK_MEDIA_CACHE_DIR:media,TEST_PUBLISHED:published,TEST_UPLOADS:uploads};
    const run=extra=>spawnSync(process.execPath,[script],{env:{...env,...extra},encoding:'utf8'});
    image('@image-a','a1');const second=image('@image-b','b1');
    const first=run();assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(fs.readFileSync(published,'utf8')).opinions.length,2);
    check({run,image,second,published,uploads,cache});
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}

test('预算不足时逐条发布已完成结果，尚未处理的图片保留旧有效摘要',()=>fixture(({run,image,published,uploads})=>{
  const before=fs.readFileSync(published,'utf8'),oldUploads=fs.readFileSync(uploads,'utf8');
  image('@image-a','a2');image('@image-b','b2');
  let result=run({DINGTALK_MAX_IMAGE_SUMMARIES_PER_RUN:'1'});
  assert.equal(result.status,0,result.stderr);
  const partial=JSON.parse(fs.readFileSync(published,'utf8')).opinions,old=JSON.parse(before).opinions;
  assert.equal(partial.length,2,'没有处理的新图片仍保留旧有效摘要');
  assert.notEqual(partial[0].summary,old[0].summary,'已完成的新识别可以发布');
  assert.equal(partial[1].summary,old[1].summary,'未处理条目不能冒充完成了新识别');
  assert.equal(JSON.parse(result.stdout).pendingImages,1);
  assert.notEqual(fs.readFileSync(uploads,'utf8'),oldUploads);
  result=run({DINGTALK_MAX_IMAGE_SUMMARIES_PER_RUN:'1'});assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(published,'utf8')).opinions.length,2);
  assert.notEqual(fs.readFileSync(published,'utf8'),before,'后续轮次补齐后才发布');
}));

test('原图暂时不可用不能移除已经发布的短图片事件',()=>fixture(({run,second,published,uploads})=>{
  const before=fs.readFileSync(published,'utf8'),oldUploads=fs.readFileSync(uploads,'utf8');
  fs.unlinkSync(second);
  const result=run();assert.equal(result.status,0,result.stderr);
  assert.equal(fs.readFileSync(published,'utf8'),before);
  assert.equal(fs.readFileSync(uploads,'utf8'),oldUploads);
  assert.equal(JSON.parse(fs.readFileSync(published,'utf8')).opinions.length,2);
  assert.equal(JSON.parse(result.stdout).pendingImages,1,'缺图留待后续恢复，不丢历史记录');
}));
