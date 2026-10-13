import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchJianfang, WeiboSnapshotError } from '../src/finance/weibo.ts';
const item = (i: number) => ({ id: String(i), author: '交易者简放', time: new Date(Date.UTC(2026, 9, 13, 0, i)).toISOString(), text: `测试微博 ${i}`, textComplete: true,
  url: `https://weibo.com/1357064103/Test${i}`, images: [] as string[], source: '微博网页版', likes: 0, comments: 0, reposts: 0, pinned: false, repost: null });
const snapshot = () => ({ schemaVersion: 1, uid: '1357064103', label: '简放', author: '交易者简放', profileUrl: 'https://www.weibo.com/u/1357064103',
  syncedAt: '2026-10-13T01:00:00Z', lastAttemptAt: '2026-10-13T01:00:00Z', status: 'ok', error: null, items: Array.from({ length: 61 }, (_, i) => item(i)) });
async function withSnapshot(fn: (file: string, dir: string) => unknown | Promise<unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jianfang-api-')); const prior = process.env.JIANFANG_SNAPSHOT_FILE;
  const file = process.env.JIANFANG_SNAPSHOT_FILE = path.join(dir, 'jianfang.json');
  try { await fn(file, dir); } finally { if (prior === undefined) delete process.env.JIANFANG_SNAPSHOT_FILE; else process.env.JIANFANG_SNAPSHOT_FILE = prior; fs.rmSync(dir, { recursive: true, force: true }); }
}
test('分页搜索完整历史并按时间倒序，全文和状态保留', async () => withSnapshot(file => {
  const data = snapshot(); data.items[0]!.images = ['/vibe-research/semi-assets/weibo/' + 'a'.repeat(64) + '.jpg']; data.items[0]!.text = '长微博'.repeat(1000) + '最后一句';
  fs.writeFileSync(file, JSON.stringify(data));
  const first = fetchJianfang(); assert.equal(first.total, 61); assert.equal(first.items[0]!.id, '60'); assert.equal(first.hasMore, true);
  assert.equal(fetchJianfang(new URLSearchParams('offset=60')).items[0]!.id, '0');
  assert.equal(fetchJianfang(new URLSearchParams({ q: '最后一句' })).items[0]!.text, data.items[0]!.text);
  assert.equal(fetchJianfang(new URLSearchParams('limit=Infinity&offset=NaN')).limit, 30);
  assert.throws(() => fetchJianfang(new URLSearchParams({ q: 'a'.repeat(201) })), WeiboSnapshotError);
}));
test('错误身份、凭据字段、损坏时间和不安全链接拒绝读取，错误信息不泄露文件路径', async () => withSnapshot(file => {
  assert.throws(() => fetchJianfang(), /尚未收到/);
  for (const data of [{ ...snapshot(), uid: '1' }, { ...snapshot(), cookie: 'test' }, { ...snapshot(), items: [{ ...item(1), time: '待验证' }] },
    { ...snapshot(), items: [{ ...item(1), url: 'javascript:alert(1)' }] }, { ...snapshot(), items: [{ ...item(1), images: ['https://evil.test/a.jpg'] }] }]) {
    fs.writeFileSync(file, JSON.stringify(data)); assert.throws(() => fetchJianfang(), WeiboSnapshotError);
  }
  const failed = { ...snapshot(), lastAttemptAt: '2026-10-13T02:00:00Z', status: 'error', error: '同步暂不可用' };
  fs.writeFileSync(file, JSON.stringify(failed)); assert.equal(fetchJianfang().syncedAt, failed.syncedAt); assert.equal(fetchJianfang().items.length, 30);
}));
test('微博接口受既有鉴权保护，真实服务返回分页结果而不联网采集', async () => withSnapshot(async (file, dir) => {
  fs.writeFileSync(file, JSON.stringify(snapshot()));
  const { createApiServer } = await import('../src/api.ts');
  const server = createApiServer({ repoRoot: path.resolve('..'), dataRoot: dir, python: 'python3', node: process.execPath }, { token: 'test-weibo-token-0123456789' });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}/weibo/jianfang?limit=1`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: 'Bearer test-weibo-token-0123456789' } });
    assert.equal(response.status, 200); assert.equal((await response.json()).items.length, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));
