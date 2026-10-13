import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRawFeed, publishRawFeed } from '../publish-dingtalk-raw.mjs';

const message = (messageId, text, extra = {}) => ({ messageId, text, sender: '测试发送者', time: '2026-10-13 10:00:00', duplicateCount: 0, ...extra });
const snapshot = (messages) => ({ conversationId: 'private-conversation', syncedAt: '2026-10-13T03:00:00Z', duplicateCount: 0, messages });

test('长短原文全部保留；重复正文合并；报价、标点与空格差异保留', () => {
  const body = '长篇原文\n'.repeat(2500) + '正文结尾也必须完整保留';
  const feed = buildRawFeed(snapshot([
    message('long', body), message('copy', body.replace(/\n/g, '\r\n'), { time: '2026-10-13 10:01:00' }),
    message('short', '谢谢'), message('short-copy', '谢谢'),
    message('price-a', '目标价格 1.5 元'), message('price-b', '目标价格 15 元'),
    message('space-a', '价格 1 0 元'), message('space-b', '价格 10 元'),
    message('punctuation-a', '需求增长？'), message('punctuation-b', '需求增长。'),
  ]), 'private-conversation');
  assert.equal(feed.messages.length, 8);
  assert.equal(feed.duplicateCount, 2);
  const long = feed.messages.find(m => m.text === body);
  assert.ok(long); assert.equal(long.duplicateCount, 1); assert.equal(long.relatedIds.length, 2);
  assert.equal(long.latestDuplicateTime, '2026-10-13 10:01:00');
  assert.equal(feed.messages.find(m => m.text === '谢谢').duplicateCount, 1);
  assert.doesNotMatch(JSON.stringify(feed), /private-conversation|messageId|duplicateMessageIds/);
});

test('超过 500 条历史原文仍完整发布；已有重复计数和关联 ID 保留', () => {
  const messages = Array.from({ length: 551 }, (_, i) => message(`source-${i}`, `历史原文 ${i}`));
  messages[0].duplicateCount = 2; messages[0].duplicateMessageIds = ['old-copy-a', 'old-copy-b'];
  const feed = buildRawFeed({ ...snapshot(messages), duplicateCount: 2 }, 'private-conversation');
  assert.equal(feed.messages.length, 551); assert.equal(feed.duplicateCount, 2);
  assert.equal(feed.messages.find(m => m.text === '历史原文 0').relatedIds.length, 3);
  assert.throws(() => buildRawFeed(snapshot(messages), 'other-conversation'));
  assert.throws(() => buildRawFeed(snapshot([message('x', '原文', { time: '无效时间' })]), 'private-conversation'));
});

test('原文单独原子上传，不依赖摘要模型，也不能覆盖摘要快照', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-raw-publish-test-'));
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    const source = path.join(dir, 'raw.json'); const captured = path.join(dir, 'captured.json'); const key = path.join(dir, 'key'); const calls = path.join(dir, 'calls');
    fs.writeFileSync(source, JSON.stringify(snapshot([message('a', '短消息也保留')])));
    fs.writeFileSync(key, 'test-key');
    fs.writeFileSync(path.join(bin, 'scp'), "#!/usr/bin/env node\nrequire('node:fs').copyFileSync(process.argv.at(-2),process.env.TEST_CAPTURED);\n", { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'ssh'), "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.TEST_CALLS,process.argv.at(-1));\n", { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DINGTALK_LOCAL_SNAPSHOT_FILE: source,
      DINGTALK_CONVERSATION_ID: 'private-conversation', DINGTALK_PUSH_HOST: 'example.test', DINGTALK_PUSH_SSH_KEY: key, TEST_CAPTURED: captured, TEST_CALLS: calls,
      DINGTALK_GPT_PROVIDER_APPROVED: '0' };
    await publishRawFeed(env);
    assert.equal(JSON.parse(fs.readFileSync(captured)).messages[0].text, '短消息也保留');
    assert.match(fs.readFileSync(calls, 'utf8'), /chmod 0640.*mv -f.*dingtalk-raw\.json/);
    await assert.rejects(() => publishRawFeed({ ...env, DINGTALK_REMOTE_RAW_SNAPSHOT_FILE: '/opt/vibe-research/shared/semi/dingtalk.json' }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('发布真实配图引用和本站缓存路径，原文及关联 ID 完整保留', () => {
  const original = '原文\n\n[图片消息](mediaId=@image-a)\n[图片消息](mediaId=@image-b)';
  const url = `/dingtalk/media/${'a'.repeat(64)}.png`;
  const feed = buildRawFeed(snapshot([message('picture', original)]), 'private-conversation', new Map([['@image-a', url]]));
  assert.equal(feed.messages[0].text, original);
  assert.deepEqual(feed.messages[0].images, [{ reference: '@image-a', url }]);
  assert.equal(feed.messages[0].relatedIds.length, 1);
});

test('先上传配图再发布正文，图片上传失败不会替换原文快照', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-image-publish-test-'));
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    const cache = path.join(dir, 'cache'); fs.mkdirSync(cache);
    const { createHash } = await import('node:crypto');
    const hash = value => createHash('sha256').update(value).digest('hex');
    const bytes = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex');
    const filename = `${hash(bytes)}.png`;
    fs.writeFileSync(path.join(cache, filename), bytes);
    fs.writeFileSync(path.join(cache, 'index.json'), JSON.stringify({ schemaVersion: 1, conversationHash: hash('private-conversation'), files: { [hash('@cached-image')]: filename } }));
    const source = path.join(dir, 'raw.json'); const calls = path.join(dir, 'calls'); const key = path.join(dir, 'key');
    fs.writeFileSync(key, 'test-key');
    fs.writeFileSync(source, JSON.stringify(snapshot([message('a', '原文[图片消息](mediaId=@cached-image)')])));
    fs.writeFileSync(path.join(bin, 'scp'), `#!/usr/bin/env node
const fs=require('node:fs');const directory=fs.statSync(process.argv.at(-2)).isDirectory();
fs.appendFileSync(process.env.TEST_CALLS, directory?'images-upload\\n':'feed-upload\\n');
if(directory && process.env.TEST_FAIL_IMAGES==='1')process.exit(1);
`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.TEST_CALLS, process.argv.at(-1).includes('rmdir')?'images-publish\\n':'feed-publish\\n');
`, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DINGTALK_LOCAL_SNAPSHOT_FILE: source, DINGTALK_MEDIA_CACHE_DIR: cache,
      DINGTALK_CONVERSATION_ID: 'private-conversation', DINGTALK_PUSH_HOST: 'example.test', DINGTALK_PUSH_SSH_KEY: key, TEST_CALLS: calls };
    await publishRawFeed(env);
    assert.equal(fs.readFileSync(calls, 'utf8'), 'images-upload\nimages-publish\nfeed-upload\nfeed-publish\n');
    fs.writeFileSync(calls, '');
    fs.writeFileSync(source, JSON.stringify(snapshot([message('a', '原文[图片消息](mediaId=@cached-image)'), message('new', '新增内容')] )));
    await assert.rejects(() => publishRawFeed({ ...env, TEST_FAIL_IMAGES: '1' }));
    assert.equal(fs.readFileSync(calls, 'utf8'), 'images-upload\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('只有重复到达时不再上传原文，首次时间和关联记录保留', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jqz-no-republish-'));
 try {
  const bin=path.join(dir,'bin');fs.mkdirSync(bin);const source=path.join(dir,'raw.json'),key=path.join(dir,'key'),calls=path.join(dir,'calls');fs.writeFileSync(key,'test-key');
  for(const tool of ['scp','ssh'])fs.writeFileSync(path.join(bin,tool),`#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.TEST_CALLS,'${tool}\\n');\n`,{mode:0o700});
  const env={...process.env,PATH:`${bin}:${process.env.PATH}`,DINGTALK_LOCAL_SNAPSHOT_FILE:source,DINGTALK_CONVERSATION_ID:'private-conversation',DINGTALK_PUSH_HOST:'example.test',DINGTALK_PUSH_SSH_KEY:key,TEST_CALLS:calls};
  const first=message('first','业务纪要。'.repeat(40)+'订单1000台，客户（剑桥）光模块 NPO项目。');
  fs.writeFileSync(source,JSON.stringify(snapshot([first])));await publishRawFeed(env);const before=fs.readFileSync(calls,'utf8');
  const copy=message('later',first.text.replace('剑桥','剑桥思科一体').replaceAll('。','。\n\n'),{time:'2026-10-13 11:00:00'});
  fs.writeFileSync(source,JSON.stringify({...snapshot([first,copy]),syncedAt:'2026-10-13T04:00:00Z'}));await publishRawFeed(env);
  assert.equal(fs.readFileSync(calls,'utf8'),before,'重复消息不触发上传');
  const result=buildRawFeed(snapshot([copy,first]),'private-conversation');assert.equal(result.messages.length,1);assert.equal(result.messages[0].time,first.time);assert.equal(result.messages[0].relatedIds.length,2);assert.equal(result.messages[0].versions[0].text,copy.text);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
