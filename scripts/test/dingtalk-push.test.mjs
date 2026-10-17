import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const script = new URL('../push-dingtalk-group.mjs', import.meta.url).pathname;
test('原文只保留本地；模型输出白名单摘要；失败禁止上传', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-test-'));
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    const response = path.join(dir, 'response.json'), captured = path.join(dir, 'captured.json'), calls = path.join(dir, 'calls'), key = path.join(dir, 'key');
    fs.writeFileSync(key, 'test-key');
    fs.writeFileSync(path.join(bin, 'dws'), "#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(process.env.TEST_RESPONSE));\n", { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'gpt'), "#!/usr/bin/env node\nconst fs=require('fs');if(process.env.TEST_GPT_FAIL)process.exit(1);fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],JSON.stringify({kind:'opinion',title:'产业调研',summary:process.env.TEST_OVERSIZE?'过长概述。'.repeat(200):'第三方表示行业需求存在变化，尚需验证。',keyPoints:['关注需求变化'],caveats:['缺少独立数据，待核验']}));fs.appendFileSync(process.env.TEST_CALLS,'gpt\\n');\n", { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'scp'), "#!/usr/bin/env node\nconst fs=require('fs');fs.copyFileSync(process.argv.at(-2),process.env.TEST_CAPTURED);fs.appendFileSync(process.env.TEST_CALLS,'scp\\n');\n", { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'ssh'), "#!/usr/bin/env node\nrequire('fs').appendFileSync(process.env.TEST_CALLS,'ssh\\n');\n", { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DWS_BIN: path.join(bin, 'dws'), DINGTALK_GPT_BIN: path.join(bin, 'gpt'), TEST_RESPONSE: response, TEST_CAPTURED: captured, TEST_CALLS: calls,
      DINGTALK_RETRY_DELAYS_MS: '1,1', DINGTALK_GPT_PROVIDER_APPROVED: '1', DINGTALK_GROUP_NAME: '测试群', DINGTALK_CONVERSATION_ID: 'private-conversation', DINGTALK_PUSH_HOST: 'example.test', DINGTALK_PUSH_SSH_KEY: key,
      DINGTALK_LOCAL_SNAPSHOT_FILE: path.join(dir, 'raw.json'), DINGTALK_LOCAL_SUMMARY_FILE: path.join(dir, 'summary.json') };
    const run = (extra = {}) => spawnSync(process.execPath, [script], { env: { ...env, ...extra }, encoding: 'utf8' });
    const noConsent = run({ DINGTALK_GPT_PROVIDER_APPROVED: '0' });
    assert.notEqual(noConsent.status, 0); assert.equal(fs.existsSync(calls), false, '未经确认不得同步或推送');
    const original = '研究调研原文内容仅应在 Nova 本地保留。'.repeat(15);
    fs.writeFileSync(response, JSON.stringify({ complete: true, messages: [{ messageId: 'private-id', conversationId: 'private-conversation', text: original, sender: '甲', createTime: new Date().toISOString() }] }));
    let result = run({ DINGTALK_SUMMARY_ONLY: '1' }); assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(calls), true); assert.equal(fs.readFileSync(calls, 'utf8'), 'gpt\n');
    assert.equal(fs.existsSync(captured), false, '本地试运行不可上传');
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.readFileSync(env.DINGTALK_LOCAL_SNAPSHOT_FILE, 'utf8').includes(original));
    const published = fs.readFileSync(captured, 'utf8');
    assert.doesNotMatch(published, /private-conversation|private-id|研究调研原文内容|sender|textHash|messages/);
    const body = JSON.parse(published); assert.equal(body.schemaVersion, 2); assert.equal(body.label, '击球区观点'); assert.equal(body.opinions.length, 1);
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(calls, 'utf8').split('gpt').length - 1, 1, '摘要应缓存，不重复模型调用');
    const latestPublished = fs.readFileSync(captured, 'utf8');
    fs.writeFileSync(response, JSON.stringify({ complete: true, messages: [JSON.parse(fs.readFileSync(response)).messages[0], { messageId: 'new-id', conversationId: 'private-conversation', text: '新的原文调研材料'.repeat(40), sender: '乙', createTime: new Date().toISOString() }] }));
    result = run({ TEST_GPT_FAIL: '1' }); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).failedJobs, 1);
    assert.equal(fs.readFileSync(captured, 'utf8'), latestPublished);
    result = run({ TEST_OVERSIZE: '1', DINGTALK_SUMMARY_ONLY: '1' }); assert.equal(result.status, 0, result.stderr);
    const latest = JSON.parse(fs.readFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, 'utf8'));
    assert.ok(Object.values(latest.entries).every(x => x.summary.length <= 800));
    assert.equal(fs.readFileSync(captured, 'utf8'), latestPublished, '超长模型输出被裁剪且仍未上传');
    const aliases = JSON.parse(fs.readFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, 'utf8'));
    const aliasId = Object.keys(aliases.entries)[0];
    const sourceHash = aliases.entries[aliasId].textHash;
    const rawBefore = JSON.parse(fs.readFileSync(env.DINGTALK_LOCAL_SNAPSHOT_FILE, 'utf8')).messages;
    aliases.entries[aliasId].title = '旭创、xys、高意联特、萝卜、hdg';
    aliases.entries[aliasId].summary = '中际旭创与新易盛，Coherent、联特科技；报价 1.5 元及 15 元。提高意识，关注串并联特性。罗博特科名称已规范，胡萝卜和萝卜快跑原词保留。hdg专家与HDG及Hdg交流，myhdg和hdg2原词保留。';
    aliases.entries[aliasId].keyPoints = ['“旭创”“xys”“高意联特”验证表现待核验，联特进展待核验，萝卜团队情况待核验，hdg规划待核验。'];
    aliases.entries[aliasId].caveats = ['HDG产能规划仍为交流转述，待核验。'];
    fs.writeFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, JSON.stringify(aliases));
    const modelCalls = fs.readFileSync(calls, 'utf8').split('gpt').length;
    result = run(); assert.equal(result.status, 0, result.stderr);
    const named = JSON.parse(fs.readFileSync(captured, 'utf8')).opinions.find(x => x.id === aliasId);
    assert.equal(named.title, '中际旭创、新易盛、Coherent、联特科技、罗博特科、衡东光');
    assert.equal(named.summary, '中际旭创与新易盛，Coherent、联特科技；报价 1.5 元及 15 元。提高意识，关注串并联特性。罗博特科名称已规范，胡萝卜和萝卜快跑原词保留。衡东光专家与衡东光及衡东光交流，myhdg和hdg2原词保留。');
    assert.equal(named.caveats[0], '衡东光产能规划仍为交流转述，待核验。');
    assert.equal(named.keyPoints[0], '“中际旭创”“新易盛”“Coherent”“联特科技”验证表现待核验，联特科技进展待核验，罗博特科团队情况待核验，衡东光规划待核验。');
    assert.equal(JSON.parse(fs.readFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, 'utf8')).entries[aliasId].textHash, sourceHash);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.DINGTALK_LOCAL_SNAPSHOT_FILE, 'utf8')).messages, rawBefore);
    assert.equal(fs.readFileSync(calls, 'utf8').split('gpt').length, modelCalls);
    let normalizedPublished = fs.readFileSync(captured, 'utf8');
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(captured, 'utf8')).opinions, JSON.parse(normalizedPublished).opinions, '规范全名幂等，后续同步不会再次扩展');
    normalizedPublished = fs.readFileSync(captured, 'utf8');
    const boundaryCache = JSON.parse(fs.readFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, 'utf8'));
    Object.assign(boundaryCache.entries[aliasId], {
      title: '甲'.repeat(97) + 'hdg2', summary: '乙'.repeat(797) + 'HDGExtra',
      keyPoints: ['丙'.repeat(237) + 'Hdg2'], caveats: ['丁'.repeat(237) + 'hdg2'],
    });
    fs.writeFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, JSON.stringify(boundaryCache));
    result = run(); assert.equal(result.status, 0, result.stderr);
    const boundary = JSON.parse(fs.readFileSync(captured, 'utf8')).opinions.find(x => x.id === aliasId);
    assert.equal(boundary.title, '甲'.repeat(97)); assert.equal(boundary.summary, '乙'.repeat(797));
    assert.deepEqual(boundary.keyPoints, ['丙'.repeat(237)]); assert.deepEqual(boundary.caveats, ['丁'.repeat(237)]);
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(captured, 'utf8')).opinions.find(x => x.id === aliasId), boundary, '裁剪边界不制造公司缩写，重复发布保持幂等');
    assert.deepEqual(JSON.parse(fs.readFileSync(env.DINGTALK_LOCAL_SNAPSHOT_FILE, 'utf8')).messages, rawBefore);
    assert.equal(fs.readFileSync(calls, 'utf8').split('gpt').length, modelCalls);
    const mixedBoundaryCache = JSON.parse(fs.readFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, 'utf8'));
    Object.assign(mixedBoundaryCache.entries[aliasId], {
      title: '旭创' + '甲'.repeat(93) + 'hdg2', summary: '旭创' + '乙'.repeat(793) + 'HDGExtra',
      keyPoints: ['旭创' + '丙'.repeat(233) + 'Hdg2'], caveats: ['旭创' + '丁'.repeat(233) + 'hdg2'],
    });
    fs.writeFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, JSON.stringify(mixedBoundaryCache));
    result = run(); assert.equal(result.status, 0, result.stderr);
    const mixedBoundary = JSON.parse(fs.readFileSync(captured, 'utf8')).opinions.find(x => x.id === aliasId);
    assert.equal(mixedBoundary.title, '中际旭创' + '甲'.repeat(93)); assert.equal(mixedBoundary.summary, '中际旭创' + '乙'.repeat(793));
    assert.deepEqual(mixedBoundary.keyPoints, ['中际旭创' + '丙'.repeat(233)]); assert.deepEqual(mixedBoundary.caveats, ['中际旭创' + '丁'.repeat(233)]);
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(captured, 'utf8')).opinions.find(x => x.id === aliasId), mixedBoundary, '旧别名扩展后的最终裁剪不制造公司缩写');
    const legacyBoundaryCache = JSON.parse(fs.readFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, 'utf8'));
    Object.assign(legacyBoundaryCache.entries[aliasId], {
      title: '甲'.repeat(97) + '较高意愿', summary: '乙'.repeat(797) + '较高意愿',
      keyPoints: ['丙'.repeat(237) + '较高意愿'], caveats: ['丁'.repeat(237) + '较高意愿'],
    });
    fs.writeFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, JSON.stringify(legacyBoundaryCache));
    result = run(); assert.equal(result.status, 0, result.stderr);
    const legacyBoundary = JSON.parse(fs.readFileSync(captured, 'utf8')).opinions.find(x => x.id === aliasId);
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(captured, 'utf8')).opinions.find(x => x.id === aliasId), legacyBoundary, '新增缩写规则保持既有中文上下文在裁剪后的缓存幂等性');
    normalizedPublished = fs.readFileSync(captured, 'utf8');
    const responseBeforeCopy = JSON.parse(fs.readFileSync(response, 'utf8'));
    const copied = responseBeforeCopy.messages[0];
    responseBeforeCopy.messages.push({ ...copied, messageId: 'later-duplicate', sender: '转发者', text: copied.text.replaceAll('。', '。\n\n'), createTime: new Date(Date.parse(copied.createTime) + 60000).toISOString() });
    fs.writeFileSync(response, JSON.stringify(responseBeforeCopy));
    const callsBeforeCopy = fs.readFileSync(calls, 'utf8');
    result = run({ TEST_GPT_FAIL: '1' }); assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(calls, 'utf8'), callsBeforeCopy, '重复新 ID 不调用模型也不再次发布总结');
    assert.equal(fs.readFileSync(captured, 'utf8'), normalizedPublished);
    result = run({ DINGTALK_REPUBLISH_ONLY: '1', DWS_BIN: '/bin/false', TEST_GPT_FAIL: '1' }); assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(calls, 'utf8'), callsBeforeCopy, '维护重发使用真实存档与缓存');
    const oldArchive = JSON.parse(fs.readFileSync(env.DINGTALK_LOCAL_SNAPSHOT_FILE, 'utf8'));
    const priorMessage = oldArchive.messages[0];
    oldArchive.messages.push({ ...priorMessage, messageId: 'legacy-copy-without-cache', time: new Date(Date.parse(priorMessage.time) + 60000).toISOString(), text: priorMessage.text.replaceAll('原文', '原文\n\n') });
    fs.writeFileSync(env.DINGTALK_LOCAL_SNAPSHOT_FILE, JSON.stringify(oldArchive));
    result = run({ DINGTALK_REPUBLISH_ONLY: '1', DWS_BIN: '/bin/false', TEST_GPT_FAIL: '1' }); assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(calls, 'utf8'), callsBeforeCopy, '维护模式直接合并旧历史，不要求重复副本缓存');
    const injected = JSON.parse(fs.readFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, 'utf8'));
    const one = Object.keys(injected.entries)[0]; injected.entries[one].text = 'malicious-source-copy';
    fs.writeFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, JSON.stringify(injected));
    result = run(); assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(fs.readFileSync(captured, 'utf8'), /malicious-source-copy/, '拒绝带原文的缓存并恢复独立保存的有效结果');
    assert.equal(fs.readFileSync(captured, 'utf8'), normalizedPublished);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('短图片通知读取真实本地附件，缓存识别结果并在图片变化时重新整理', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-image-event-'));
  try {
    const hash = value => createHash('sha256').update(value).digest('hex');
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    const media = path.join(dir, 'media'); fs.mkdirSync(media);
    const calls = path.join(dir, 'model-calls.jsonl'), captured = path.join(dir, 'published.json'), key = path.join(dir, 'key');
    fs.writeFileSync(key, 'fixture-key');
    fs.writeFileSync(path.join(bin, 'gpt'), `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);const imageIndex=args.indexOf('--image');
if(imageIndex<0)process.exit(8);
const images=[];for(let i=imageIndex+1;i<args.length&&!args[i].startsWith('-');i++)images.push(args[i]);
if(!images.length||images.some(file=>!fs.statSync(file).isFile()))process.exit(9);
if(process.env.TEST_IMAGE_MODEL_FAIL)process.exit(7);
fs.appendFileSync(process.env.TEST_IMAGE_CALLS,JSON.stringify(images)+'\\n');
fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({kind:'event',title:'材料价格调整通知',summary:'图片通知列明指定覆铜板产品调价200%，自2027年1月1日工厂出货起执行。',keyPoints:['R-1705全部规格；其余列示型号限厚度1.1毫米及以上。'],caveats:[]}));
`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'scp'), "#!/usr/bin/env node\nrequire('node:fs').copyFileSync(process.argv.at(-2),process.env.TEST_PUBLISHED);\n", { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/usr/bin/env node\n', { mode: 0o700 });
    const rawFile = path.join(dir, 'raw.json'), cacheFile = path.join(dir, 'summaries.json');
    const original = { conversationId: 'image-test', syncedAt: '2026-10-13T13:00:00Z', duplicateCount: 0, messages: [{ messageId: 'image-notice', sender: 'test-sender', time: '2026-10-13T12:00:00Z', text: '材料调价[图片消息](mediaId=@notice)', duplicateCount: 0, duplicateMessageIds: [] }] };
    fs.writeFileSync(rawFile, JSON.stringify(original));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const installImage = bytes => {
      const filename = `${hash(bytes)}.png`;fs.writeFileSync(path.join(media, filename),bytes);
      fs.writeFileSync(path.join(media,'index.json'),JSON.stringify({schemaVersion:1,conversationHash:hash('image-test'),files:{[hash('@notice')]:filename}}));return path.join(media,filename);
    };
    const firstImage = installImage(png);
    fs.writeFileSync(cacheFile,JSON.stringify({entries:{[hash(original.messages[0].messageId)]:{id:hash(original.messages[0].messageId),time:original.messages[0].time,textHash:hash(original.messages[0].text),title:'旧图片消息',summary:'旧整理未读取附图。',keyPoints:['只有文字标题。'],caveats:['图片正文未能读取。']}}}));
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DINGTALK_GPT_BIN: path.join(bin,'gpt'), DWS_BIN:'/bin/false', DINGTALK_USE_ARCHIVE:'1', DINGTALK_GPT_PROVIDER_APPROVED:'1', DINGTALK_CONVERSATION_ID:'image-test', DINGTALK_PUSH_HOST:'fixture.invalid', DINGTALK_PUSH_USER:'ubuntu', DINGTALK_PUSH_SSH_KEY:key, DINGTALK_LOCAL_SNAPSHOT_FILE:rawFile, DINGTALK_LOCAL_SUMMARY_FILE:cacheFile, DINGTALK_MEDIA_CACHE_DIR:media, TEST_IMAGE_CALLS:calls, TEST_PUBLISHED:captured };
    const run = extra => spawnSync(process.execPath,[script],{env:{...env,...extra},encoding:'utf8'});
    let result=run();assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(calls,'utf8').trim()),[firstImage]);
    const published=JSON.parse(fs.readFileSync(captured,'utf8'));
    assert.equal(published.opinions.length,1,'短图片消息也必须进入整理信息');
    assert.equal(published.opinions[0].kind,'event');
    assert.match(published.opinions[0].summary,/200%.*2027年1月1日/);
    assert.doesNotMatch(fs.readFileSync(captured,'utf8'),/inputHash|@notice|image-notice|media\/|原始消息|textHash/);
    const cached=Object.values(JSON.parse(fs.readFileSync(cacheFile,'utf8')).entries)[0];
    assert.equal(cached.textHash,hash(original.messages[0].text));
    assert.match(cached.inputHash,/^[a-f0-9]{64}$/);
    result=run();assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(calls,'utf8').trim().split('\n').length,1,'相同图片不重复调用模型');
    installImage(Buffer.concat([png,Buffer.from('image-version-2')]));
    result=run();assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(calls,'utf8').trim().split('\n').length,2,'正文未变但图片变化也要重新识别');
    assert.equal(fs.readFileSync(rawFile,'utf8'),JSON.stringify(original),'识别不改写原始消息');
    const beforePublish=fs.readFileSync(captured,'utf8');
    installImage(Buffer.concat([png,Buffer.from('image-version-3')]));
    result=run({TEST_IMAGE_MODEL_FAIL:'1'});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).failedJobs,1);assert.equal(fs.readFileSync(captured,'utf8'),beforePublish,'图片识别失败保留已发布结果');
    result=run({DINGTALK_REPUBLISH_ONLY:'1',TEST_IMAGE_MODEL_FAIL:'1'});assert.notEqual(result.status,0,'图片已经变化时维护重发不能冒充完成了新识别');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
