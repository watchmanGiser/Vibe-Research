import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const script = new URL('../push-dingtalk-group.mjs', import.meta.url).pathname;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
function fixture(check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-processing-'));
  try {
    const bin = path.join(root, 'bin'), media = path.join(root, 'media'); fs.mkdirSync(bin); fs.mkdirSync(media);
    const raw = path.join(root, 'raw.json'), cache = path.join(root, 'summary.json'), calls = path.join(root, 'calls.jsonl'), published = path.join(root, 'published.json'), key = path.join(root, 'key'); fs.writeFileSync(key, 'fixture-ssh');
    const state = `${cache}.jobs.json`, ledger = `${cache}.usage.jsonl`;
    fs.writeFileSync(path.join(bin, 'gpt'), `#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2),input=fs.readFileSync(0,'utf8'),images=a.includes('--image');
const jobs=Object.values(JSON.parse(fs.readFileSync(process.env.TEST_STATE)).jobs).filter(job=>job.status==='running');
fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({images,running:jobs.length,attempts:jobs[0]?.attempts,failed:input.includes('失败消息'),wrongOCR:input.includes('140%')})+'\\n');
if(input.includes('失败消息')||(process.env.TEST_REPAIR_TRANSIENT&&!images))process.exit(7);
const research=input.includes('类型修正消息');
const report={publisher:'摩根士丹利',title:'OCP research',originalText:'The report expects commercial production from 2028 onwards.'};
const value={kind:research?(images?'opinion':'research'):'event',title:research?'机构研报要点':'材料调价通知',summary:research?'报告预计2028年商业化。':process.env.TEST_LONG_SUMMARY?'前期整理指出供需关系仍需结合后续披露，预计变化取决于订单兑现。'.repeat(5):'通知指定产品自2027年1月1日起调价20%。',keyPoints:['按所附资料的条件记录。'],caveats:[],report:research?report:null,sourceText:process.env.TEST_WRONG_OCR?'材料调价140%':images&&!research?'材料调价通知：指定产品20%，2027年1月1日起。':null};
fs.writeFileSync(a[a.indexOf('-o')+1],JSON.stringify(value));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10000,cached_input_tokens:8000,output_tokens:200}}));
`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'scp'), '#!/usr/bin/env node\nrequire("node:fs").copyFileSync(process.argv.at(-2),process.env.TEST_PUBLISHED);\n', { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/usr/bin/env node\n', { mode: 0o700 });
    const data = { conversationId: 'processing-test', syncedAt: '2026-10-14T00:00:00Z', duplicateCount: 0, messages: [] };
    const write = () => fs.writeFileSync(raw, JSON.stringify(data));
    const message = (id, text) => ({ messageId: id, time: '2026-10-14T00:00:00Z', text, sender: 'fixture', duplicateCount: 0 });
    const files = {};
    const image = ref => { const name = hash(png) + '.png'; fs.writeFileSync(path.join(media, name), png); files[hash(ref)] = name; fs.writeFileSync(path.join(media, 'index.json'), JSON.stringify({ schemaVersion: 1, conversationHash: hash(data.conversationId), files })); };
    const env = { ...process.env, PATH: bin + ':' + process.env.PATH, DINGTALK_USE_ARCHIVE: '1', DINGTALK_GPT_PROVIDER_APPROVED: '1', DINGTALK_GPT_BIN: path.join(bin, 'gpt'), DINGTALK_CONVERSATION_ID: data.conversationId, DINGTALK_PUSH_HOST: 'fixture.invalid', DINGTALK_PUSH_SSH_KEY: key, DINGTALK_LOCAL_SNAPSHOT_FILE: raw, DINGTALK_LOCAL_SUMMARY_FILE: cache, DINGTALK_MEDIA_CACHE_DIR: media, TEST_STATE: state, TEST_CALLS: calls, TEST_PUBLISHED: published };
    const run = extra => { write(); return spawnSync(process.execPath, [script], { env: { ...env, ...extra }, encoding: 'utf8' }); };
    const records = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
    check({ data, message, image, run, records, state, ledger, published, raw, cache });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('失败消息不阻断新消息；冷却、重启和三次封顶可阻止重复模型调用', () => fixture(({ data, message, run, records, state, ledger, published, raw }) => {
  data.messages = [message('bad', '失败消息的正文。'.repeat(30)), message('good', '成功消息的正文。'.repeat(30))];
  let result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(published)).opinions.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(raw)).messages.length, 2, '失败不能删除原文');
  assert.equal(records().length, 2); assert.ok(records().every(record => record.running === 1 && record.attempts === 1), '调用前必须已保存处理中状态');
  const first = fs.readFileSync(published, 'utf8');
  result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(records().length, 2, '新进程也必须遵守冷却');
  for (let i = 0; i < 2; i++) {
    const queue = JSON.parse(fs.readFileSync(state));
    for (const job of Object.values(queue.jobs)) if (job.status === 'retry_wait') job.nextRetryAt = 0;
    fs.writeFileSync(state, JSON.stringify(queue)); result = run(); assert.equal(result.status, 0, result.stderr);
  }
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(records().filter(record => record.failed).length, 3);
  assert.equal(records().length, 4); assert.equal(fs.readFileSync(published, 'utf8'), first);
  const failed = Object.values(JSON.parse(fs.readFileSync(state)).jobs).find(job => job.status === 'failed');
  assert.equal(failed.attempts, 3);
  const events = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event => event.event === 'finished' && event.usageStatus === 'unknown').length, 3);
  data.messages.push({ ...data.messages[1], messageId: 'copy', text: data.messages[1].text + '\n\n' });
  run(); assert.equal(records().length, 4, '重发不能重置失败次数或重跑成功消息');
}));
test('同一图片配不同正文，复用已识别文字而不再次发送原图', () => fixture(({ data, message, image, run, records }) => {
  image('@notice'); data.messages = [message('notice', '调价通知[图片消息](mediaId=@notice)')];
  let result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(records()[0].images, true);
  data.messages[0].text = '新补充的调价通知说明[图片消息](mediaId=@notice)';
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(records().length, 2); assert.equal(records()[1].images, false, '只有正文变化时应复用原图识别');
  run(); assert.equal(records().length, 2);
}));
test('资料类型与研报字段冲突时，只做一次无图片格式修正并记录第二次尝试', () => fixture(({ data, message, image, run, records, state, published }) => {
  image('@research'); data.messages = [message('research', '类型修正消息：大摩研报[图片消息](mediaId=@research)')];
  const result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(records().length, 2); assert.equal(records()[0].images, true); assert.equal(records()[1].images, false);
  assert.deepEqual(records().map(record => record.attempts), [1, 2]);
  const job = Object.values(JSON.parse(fs.readFileSync(state)).jobs)[0]; assert.equal(job.status, 'done'); assert.equal(job.repairs, 1);
  const output = fs.readFileSync(published, 'utf8'); assert.equal(JSON.parse(output).opinions[0].kind, 'research');
  assert.doesNotMatch(output, /待核验|sourceText|attempts|nextRetryAt/);
  run(); assert.equal(records().length, 2);
}));
test('每日调用上限跨进程有效；新增消息保留队列和原文', () => fixture(({ data, message, run, records, state, raw }) => {
  data.messages = [message('one', '第一份成功材料。'.repeat(30)), message('two', '第二份成功材料。'.repeat(30))];
  let result = run({ DINGTALK_DAILY_CALL_BUDGET: '1' }); assert.equal(result.status, 0, result.stderr);
  assert.equal(records().length, 1);
  result = run({ DINGTALK_DAILY_CALL_BUDGET: '1' }); assert.equal(result.status, 0, result.stderr);
  assert.equal(records().length, 1);
  assert.equal(Object.values(JSON.parse(fs.readFileSync(state)).jobs).filter(job => job.status === 'pending').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(raw)).messages.length, 2);
}));

test('原文更新引用旧摘要时，失败仍保留对应历史来源的有效摘要', () => fixture(({ data, message, run, published }) => {
  data.messages = [message('history', '原始调研材料内容。'.repeat(30))];
  let result = run({ TEST_LONG_SUMMARY: '1' }); assert.equal(result.status, 0, result.stderr);
  const original = JSON.parse(fs.readFileSync(published)).opinions[0];
  assert.ok(original.summary.length >= 80);
  data.messages[0].text = '失败消息更新，引用以前的整理：' + original.summary;
  data.messages.push(message('new-success', '其他新增材料内容。'.repeat(30)));
  result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).failedJobs, 1);
  const current = JSON.parse(fs.readFileSync(published)).opinions;
  assert.equal(current.length, 2); assert.deepEqual(current.find(item => item.id === original.id), original, '旧摘要不能用新原文重新判无效');
}));
test('无图片的正文整理和格式修正不能覆盖原图识别缓存', () => fixture(({ data, message, image, run, records, cache }) => {
  image('@ocr'); data.messages = [message('ocr', '原图识别通知[图片消息](mediaId=@ocr)')];
  let result = run(); assert.equal(result.status, 0, result.stderr);
  const directory = cache + '.artifacts', file = fs.readdirSync(directory).find(name => name.startsWith('ocr-'));
  const before = fs.readFileSync(path.join(directory, file), 'utf8');
  data.messages[0].text = '补充说明一[图片消息](mediaId=@ocr)';
  result = run({ TEST_WRONG_OCR: '1' }); assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(directory, file), 'utf8'), before);
  data.messages[0].text = '补充说明二[图片消息](mediaId=@ocr)';
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(records().length, 3); assert.equal(records()[2].wrongOCR, false);
}));
test('跨轮格式修正只在真正调用时计次，传输失败可用剩余第三次额度', () => fixture(({ data, message, image, run, records, state, published }) => {
  image('@format'); data.messages = [message('format', '类型修正消息：大摩研报[图片消息](mediaId=@format)')];
  let result = run({ DINGTALK_DAILY_CALL_BUDGET: '1' }); assert.equal(result.status, 0, result.stderr);
  let queue = JSON.parse(fs.readFileSync(state)), job = Object.values(queue.jobs)[0];
  assert.equal(job.attempts, 1); assert.equal(job.status, 'retry_wait');
  job.nextRetryAt = 0; fs.writeFileSync(state, JSON.stringify(queue));
  result = run({ DINGTALK_DAILY_CALL_BUDGET: '2', TEST_REPAIR_TRANSIENT: '1' }); assert.equal(result.status, 0, result.stderr);
  queue = JSON.parse(fs.readFileSync(state)); job = Object.values(queue.jobs)[0];
  assert.equal(records().length, 2); assert.equal(job.attempts, 2); assert.equal(job.status, 'retry_wait');
  job.nextRetryAt = 0; fs.writeFileSync(state, JSON.stringify(queue));
  result = run({ DINGTALK_DAILY_CALL_BUDGET: '3' }); assert.equal(result.status, 0, result.stderr);
  job = Object.values(JSON.parse(fs.readFileSync(state)).jobs)[0];
  assert.equal(records().length, 3); assert.equal(job.attempts, 3); assert.equal(job.repairs, 1); assert.equal(job.status, 'done');
  assert.equal(JSON.parse(fs.readFileSync(published)).opinions[0].kind, 'research');
}));
test('不同媒体引用的相同图片和正文只发布一个稳定代表，原始来源仍保留', () => fixture(({ data, message, image, run, records, published, raw }) => {
  image('@copy-a'); image('@copy-b');
  data.messages = [message('copy-a', '同一调价公告[图片消息](mediaId=@copy-a)'), { ...message('copy-b', '同一调价公告[图片消息](mediaId=@copy-b)'), time: '2026-10-14T01:00:00Z' }];
  let result = run(); assert.equal(result.status, 0, result.stderr);
  const first = JSON.parse(fs.readFileSync(published)).opinions;
  assert.equal(records().length, 1); assert.equal(first.length, 1); assert.equal(first[0].id, hash('copy-a'));
  assert.equal(JSON.parse(fs.readFileSync(raw)).messages.length, 2);
  image('@copy-c'); data.messages.push({ ...message('copy-c', '同一调价公告[图片消息](mediaId=@copy-c)'), time: '2026-10-14T02:00:00Z' });
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(records().length, 1); assert.deepEqual(JSON.parse(fs.readFileSync(published)).opinions, first);
}));
