import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const script = new URL('../push-dingtalk-group.mjs', import.meta.url).pathname;

test('整理读取实际文档正文，下载未完成时跳过文件名摘要；正文变更后重新整理', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-document-summary-'));
  try {
    const cache = path.join(root, 'documents'); fs.mkdirSync(cache);
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    const source = path.join(root, 'raw.json'), summaries = path.join(root,'summaries.json'), captured = path.join(root,'prompt.txt'), key = path.join(root, 'key');
    const reference = 'https://pushmedia.oss-cn-beijing.aliyuncs.com/test.pdf';
    const raw = { conversationId: 'document-summary-fixture', syncedAt: '2026-10-14T02:00:00Z', duplicateCount: 0,
      messages: [{ messageId: 'document-message', sender: '测试发送者', time: '2026-10-14 10:00:00', text: `[研报.pdf](${reference})`, duplicateCount: 0 }] };
    fs.writeFileSync(source,JSON.stringify(raw)); fs.writeFileSync(key,'fixture');
    fs.writeFileSync(path.join(bin, 'gpt'), `#!/usr/bin/env node
const fs = require('node:fs'); let input=''; process.stdin.on('data',chunk=>input+=chunk); process.stdin.on('end',()=>{
fs.writeFileSync(process.env.TEST_PROMPT,input);
const schema=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--output-schema')+1]));if(schema.properties.report.properties.originalText.enum?.[0]!=='')process.exit(3);const hasImages=process.argv.includes('--image');if(hasImages&&schema.properties.sourceText.type==='null')process.exit(3);
fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],JSON.stringify({kind:'research',report:{publisher:'测试研究机构',title:'实际文件标题',originalText:''},sourceText:hasImages?'实际附图识别文字：报价1.5元，2026年11月1日实施。':null,title:'文档资料梳理',summary:'报告介绍了需求变化及价格假设。',keyPoints:['报告预测需结合后续披露验证。'],caveats:[]}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:0,output_tokens:30}})); });`, {mode:0o700});
    const env = {...process.env,DINGTALK_USE_ARCHIVE:'1',DINGTALK_GPT_PROVIDER_APPROVED:'1',DINGTALK_GPT_BIN:path.join(bin,'gpt'),DINGTALK_CONVERSATION_ID:raw.conversationId,
      DINGTALK_PUSH_HOST:'fixture.invalid',DINGTALK_PUSH_SSH_KEY:key,DINGTALK_LOCAL_SNAPSHOT_FILE:source,DINGTALK_LOCAL_SUMMARY_FILE:summaries,
      DINGTALK_DOCUMENT_CACHE_DIR:cache,DINGTALK_MEDIA_CACHE_DIR:path.join(root,'images'),DINGTALK_SUMMARY_ONLY:'1',TEST_PROMPT:captured};
    const run = extra => spawnSync(process.execPath,[script],{env:{...env,...extra},encoding:'utf8'});
    let result=run(); assert.equal(result.status,0,result.stderr); assert.ok(!fs.existsSync(captured),'不能仅依据文件名调用模型');
    const bytes=Buffer.from('%PDF-1.7\nfixture'); let fingerprint=hash(bytes);
    fs.writeFileSync(path.join(cache,fingerprint+'.pdf'),bytes);
    const seed = text => {
      const textFile=fingerprint+'-'+hash(text)+'.txt';
      fs.writeFileSync(path.join(cache,textFile),text);
      fs.writeFileSync(path.join(cache,'index.json'),JSON.stringify({schemaVersion:1,conversationHash:hash(raw.conversationId),entries:{[hash(reference)]:{status:'ready',file:fingerprint+'.pdf',textFile,previewFile:fingerprint+'.pdf',pageImages:[],pageCount:1,textChars:text.length,unreadablePages:[],artifactHashes:{[textFile]:hash(text)}}}}));
    };
    const body='实际正文锚点：订单交付日期2026年11月，报价1.5元，需求增幅15%。'.repeat(5);
    seed(body);
    result=run({DINGTALK_MAX_RUN_MS:'240000'});assert.equal(result.status,0,result.stderr);
    assert.ok(!fs.existsSync(captured),'文档需要预留完整300秒，4分钟整轮不应启动');
    result=run();assert.equal(result.status,0,result.stderr);
    const cached=JSON.parse(fs.readFileSync(summaries,'utf8')).entries;assert.equal(Object.values(cached)[0].report.originalText,body.slice(0,2000),'原文摘录必须由解析正文忠实填充');
    const input=fs.readFileSync(captured,'utf8'); assert.ok(input.includes(body)); assert.match(input,/已下载并解析的 PDF\/Word 正文/);
    fs.unlinkSync(captured); result=run();assert.equal(result.status,0,result.stderr);assert.ok(!fs.existsSync(captured),'同一文件不得重复调用模型');
    seed(body+'新增正文：实际解析内容发生变化。'); result=run();assert.equal(result.status,0,result.stderr);
    assert.match(fs.readFileSync(captured,'utf8'),/新增正文：实际解析内容发生变化/);
    fs.unlinkSync(captured);
    const changedBytes=Buffer.from('%PDF-1.7\nchanged-file-with-same-extracted-text'); fingerprint=hash(changedBytes);
    fs.writeFileSync(path.join(cache,fingerprint+'.pdf'),changedBytes); seed(body+'新增正文：实际解析内容发生变化。');
    result=run(); assert.equal(result.status,0,result.stderr); assert.ok(fs.existsSync(captured),'原文件指纹变化必须建立新任务，不能复用旧done结果');
    const media=path.join(root,'images');fs.mkdirSync(media,{recursive:true});
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
    const imageFile=hash(png)+'.png';fs.writeFileSync(path.join(media,imageFile),png);
    fs.writeFileSync(path.join(media,'index.json'),JSON.stringify({schemaVersion:1,conversationHash:hash(raw.conversationId),files:{[hash('@attached')]:imageFile}}));
    raw.messages[0].text+='\n[图片消息](mediaId=@attached)';fs.writeFileSync(source,JSON.stringify(raw));
    result=run();assert.equal(result.status,0,result.stderr);
    const recognitionFiles=fs.readdirSync(summaries+'.artifacts').filter(name=>name.startsWith('ocr-'));
    assert.equal(recognitionFiles.length,1,'混合研报必须保存真实附图识别文字');
    const recognized=JSON.parse(fs.readFileSync(path.join(summaries+'.artifacts',recognitionFiles[0]))).text;
    assert.equal(recognized,'实际附图识别文字：报价1.5元，2026年11月1日实施。');
    assert.ok(!recognized.includes('实际正文锚点'),'图片缓存不能写入文档摘录');
    raw.messages[0].text+='\n正文说明更新';fs.writeFileSync(source,JSON.stringify(raw));
    result=run();assert.equal(result.status,0,result.stderr);
    assert.ok(fs.readFileSync(captured,'utf8').includes(recognized),'正文变化时复用附图识别缓存');
    assert.match(fs.readFileSync(captured,'utf8'),/无论是否为研报，图片识别文字只能填 sourceText/);

  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
