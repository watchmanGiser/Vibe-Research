import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cacheMessageImages } from '../dingtalk-media.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const hash = value => createHash('sha256').update(value).digest('hex');

test('按下载 ledger 缓存全部原图、复用缓存且不保存授权信息，拒绝目录外文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-media-test-'));
  try {
    const dws = path.join(dir, 'fake-dws');
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(dws, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.TEST_CALLS, 'called\\n');
fs.mkdirSync('resources');
fs.writeFileSync('resources/image.png', Buffer.from(process.env.TEST_PNG, 'base64'));
process.stdout.write(JSON.stringify({ messagesComplete: true, messages: [{ messageId: 'msg-a', conversationId: 'test-conversation' }], resourceDownloads: { downloads: [
  { messageId: 'msg-a', resourceId: '@image-a', localPath: 'resources/image.png', downloadUrl: 'https://secret.example/?token=private' },
  { messageId: 'msg-a', resourceId: '@image-b', localPath: '../outside.png' }
] } }));
`, { mode: 0o700 });
    const raw = { conversationId: 'test-conversation', messages: [{ messageId: 'msg-a', text: '[图片消息](mediaId=@image-a)\n[图片消息](mediaId=@image-b)' }] };
    const env = { ...process.env, DINGTALK_CONVERSATION_ID: 'test-conversation', DINGTALK_MEDIA_CACHE_DIR: path.join(dir, 'cache'), DWS_BIN: dws, TEST_CALLS: calls, TEST_PNG: png.toString('base64') };
    const result = await cacheMessageImages(raw, env);
    assert.equal(result.ready, 1); assert.equal(result.unavailable, 1);
    assert.equal(result.images.get('@image-a'), `/dingtalk/media/${hash(png)}.png`);
    assert.equal(result.images.has('@image-b'), false);
    assert.doesNotMatch(fs.readFileSync(path.join(result.directory, 'index.json'), 'utf8'), /token|downloadUrl|secret\.example/);
    assert.deepEqual(fs.readFileSync(path.join(result.directory, result.filenames[0])), png);
    const cached = await cacheMessageImages({ ...raw, messages: [{ ...raw.messages[0], text: '[图片消息](mediaId=@image-a)' }] }, env);
    assert.equal(cached.ready, 1);
    assert.equal(fs.readFileSync(calls, 'utf8').trim(), 'called');
    await assert.rejects(() => cacheMessageImages(raw, { ...env, DINGTALK_CONVERSATION_ID: 'other' }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('资源查询失败时保留已有缓存与完整正文，不伪造图片网址', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-media-failure-'));
  try {
    const filename = `${hash(png)}.png`;
    fs.writeFileSync(path.join(dir, filename), png);
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schemaVersion: 1, conversationHash: hash('test-conversation'), files: { [hash('@cached')]: filename } }));
    const raw = { conversationId: 'test-conversation', messages: [{ messageId: 'msg-a', text: '全部原文\n[图片消息](mediaId=@cached)\n[图片消息](mediaId=@missing)' }] };
    const original = JSON.stringify(raw);
    const result = await cacheMessageImages(raw, { ...process.env, DINGTALK_CONVERSATION_ID: 'test-conversation', DINGTALK_MEDIA_CACHE_DIR: dir, DWS_BIN: '/bin/false' });
    assert.equal(result.ready, 1); assert.equal(result.unavailable, 1);
    assert.equal(result.images.has('@missing'), false);
    assert.equal(JSON.stringify(raw), original);
    assert.ok(fs.existsSync(path.join(dir, filename)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
