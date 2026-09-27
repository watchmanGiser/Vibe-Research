import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchDingTalkGroup, DingTalkSnapshotError } from '../src/dingtalk_semi.ts';
const opinion = { id: 'a'.repeat(64), time: '2026-09-27T00:00:00Z', title: '行业调研', summary: '第三方观点尚待核验', keyPoints: ['需求变化待核验'], caveats: ['缺少独立证据'] };
const snapshot = { schemaVersion: 2, label: '击球区观点', syncedAt: '2026-09-27T00:00:00Z', duplicateCount: 1, opinions: [opinion] };
test('拒绝旧消息原文和任何额外字段，仅接受摘要白名单', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-api-'));
  const prior = process.env.DINGTALK_SEMI_SNAPSHOT_FILE;
  try {
    const file = process.env.DINGTALK_SEMI_SNAPSHOT_FILE = path.join(dir, 'feed.json');
    assert.throws(() => fetchDingTalkGroup(), DingTalkSnapshotError);
    fs.writeFileSync(file, JSON.stringify({ group: '旧格式', messages: [{ text: '原文' }] }));
    assert.throws(() => fetchDingTalkGroup(), DingTalkSnapshotError);
    fs.writeFileSync(file, JSON.stringify({ ...snapshot, opinions: [{ ...opinion, text: '原文' }] }));
    assert.throws(() => fetchDingTalkGroup(), DingTalkSnapshotError);
    fs.writeFileSync(file, JSON.stringify(snapshot));
    assert.deepEqual(fetchDingTalkGroup().opinions, [opinion]);
  } finally { if (prior === undefined) delete process.env.DINGTALK_SEMI_SNAPSHOT_FILE; else process.env.DINGTALK_SEMI_SNAPSHOT_FILE = prior; fs.rmSync(dir, { recursive: true, force: true }); }
});
test('HTTP 鉴权、缺失 503 与只读摘要', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-http-'));
  const prior = process.env.DINGTALK_SEMI_SNAPSHOT_FILE;
  const { createApiServer } = await import('../src/api.ts');
  const token = 'test-token-0123456789';
  const server = createApiServer({ repoRoot: path.resolve('.'), dataRoot: root, python: 'python3', node: process.execPath, providerEnvKey: null }, { token });
  try {
    const file = process.env.DINGTALK_SEMI_SNAPSHOT_FILE = path.join(root, 'feed.json');
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/semi/dingtalk`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 503);
    fs.writeFileSync(file, JSON.stringify(snapshot));
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200); assert.deepEqual((await r.json()).opinions, [opinion]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); if (prior === undefined) delete process.env.DINGTALK_SEMI_SNAPSHOT_FILE; else process.env.DINGTALK_SEMI_SNAPSHOT_FILE = prior; fs.rmSync(root, { recursive: true, force: true }); }
});
