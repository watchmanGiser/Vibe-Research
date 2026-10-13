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

test('原文单独原子上传，不依赖摘要模型，也不能覆盖摘要快照', () => {
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
    publishRawFeed(env);
    assert.equal(JSON.parse(fs.readFileSync(captured)).messages[0].text, '短消息也保留');
    assert.match(fs.readFileSync(calls, 'utf8'), /chmod 0640.*mv -f.*dingtalk-raw\.json/);
    assert.throws(() => publishRawFeed({ ...env, DINGTALK_REMOTE_RAW_SNAPSHOT_FILE: '/opt/vibe-research/shared/semi/dingtalk.json' }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
