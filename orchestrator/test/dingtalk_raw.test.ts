import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchDingTalkMessages } from '../src/finance/dingtalk_raw.ts';
import { DingTalkSnapshotError } from '../src/finance/dingtalk_semi.ts';

const id = (s: string) => createHash('sha256').update(s).digest('hex');
const message = (i: number) => ({ id: id(String(i)), time: `2026-10-13T${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, sender: '测试发送者', text: `第 ${i} 条原文`, duplicateCount: 0, relatedIds: [id(String(i))], latestDuplicateTime: null });
const snapshot = (messages: ReturnType<typeof message>[]) => ({ schemaVersion: 1, label: '击球区原始消息', syncedAt: '2026-10-13T03:00:00Z', duplicateCount: 2, messages });

async function withSnapshot(fn: (file: string, dir: string) => Promise<void> | void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-raw-api-'));
  const prior = process.env.DINGTALK_RAW_SNAPSHOT_FILE;
  const file = process.env.DINGTALK_RAW_SNAPSHOT_FILE = path.join(dir, 'raw.json');
  try { await fn(file, dir); }
  finally { if (prior === undefined) delete process.env.DINGTALK_RAW_SNAPSHOT_FILE; else process.env.DINGTALK_RAW_SNAPSHOT_FILE = prior; fs.rmSync(dir, { recursive: true, force: true }); }
}

test('全部历史原文可分页遍历，正文无截断，全文搜索覆盖最后一页', async () => {
  await withSnapshot(file => {
    const messages = Array.from({ length: 551 }, (_, i) => message(i));
    messages[0]!.text = '历史长篇正文\n'.repeat(2000) + '全文末尾检索关键词';
    fs.writeFileSync(file, JSON.stringify(snapshot(messages)));
    const seen = new Set<string>();
    for (let offset = 0; offset < 551; offset += 100) {
      const result = fetchDingTalkMessages(new URLSearchParams({ offset: String(offset), limit: '100' }));
      assert.equal(result.total, 551);
      assert.equal(result.hasMore, offset + 100 < 551);
      for (const item of result.messages) seen.add(item.id);
    }
    assert.equal(seen.size, 551);
    const result = fetchDingTalkMessages(new URLSearchParams({ q: '全文末尾检索关键词' }));
    assert.equal(result.filteredTotal, 1); assert.equal(result.messages[0]!.text, messages[0]!.text);
    assert.equal(fetchDingTalkMessages(new URLSearchParams({ q: '测试发送者' })).filteredTotal, 551);
    const associated = fetchDingTalkMessages(new URLSearchParams({ id: id('0') }));
    assert.equal(associated.messages[0]!.text, messages[0]!.text);
    assert.equal(fetchDingTalkMessages(new URLSearchParams({ limit: 'Infinity', offset: 'NaN' })).limit, 30);
    assert.equal(fetchDingTalkMessages(new URLSearchParams({ limit: '9999', offset: '-1' })).limit, 100);
  });
});

test('缺失、会话字段泄漏和损坏原文拒绝读取；摘要缺失不影响原文', async () => {
  await withSnapshot(file => {
    assert.throws(() => fetchDingTalkMessages(), DingTalkSnapshotError);
    for (const data of [{ ...snapshot([message(1)]), conversationId: 'private' }, snapshot([{ ...message(1), text: '' }]), snapshot([{ ...message(1), relatedIds: ['private-message-id'] }])]) {
      fs.writeFileSync(file, JSON.stringify(data));
      assert.throws(() => fetchDingTalkMessages(), DingTalkSnapshotError);
    }
    fs.writeFileSync(file, JSON.stringify(snapshot([message(1)])));
    assert.equal(fetchDingTalkMessages().messages.length, 1);
  });
});

test('原文与摘要共用受鉴权保护的只读接口，彼此异常不影响另一栏', async () => {
  await withSnapshot(async (file, dir) => {
    const prior = process.env.DINGTALK_SEMI_SNAPSHOT_FILE;
    process.env.DINGTALK_SEMI_SNAPSHOT_FILE = path.join(dir, 'summary.json');
    const { createApiServer } = await import('../src/api.ts');
    const token = 'test-token-0123456789';
    const server = createApiServer({ repoRoot: path.resolve('.'), dataRoot: dir, python: 'python3', node: process.execPath }, { token });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/semi/dingtalk`;
      const headers = { Authorization: `Bearer ${token}` };
      assert.equal((await fetch(url + '?view=messages')).status, 401);
      assert.equal((await fetch(url + '?view=messages', { headers })).status, 503);
      fs.writeFileSync(file, JSON.stringify(snapshot([message(1)])));
      const raw = await fetch(url + '?view=messages', { headers });
      assert.equal(raw.status, 200); assert.equal((await raw.json()).messages[0].text, '第 1 条原文');
      assert.equal((await fetch(url, { headers })).status, 503);
      fs.writeFileSync(process.env.DINGTALK_SEMI_SNAPSHOT_FILE!, JSON.stringify({ schemaVersion: 2, label: '击球区观点', syncedAt: '2026-10-13T03:00:00Z', duplicateCount: 0, opinions: [] }));
      fs.unlinkSync(file);
      assert.equal((await fetch(url, { headers })).status, 200);
      assert.equal((await fetch(url + '?view=messages', { headers })).status, 503);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (prior === undefined) delete process.env.DINGTALK_SEMI_SNAPSHOT_FILE; else process.env.DINGTALK_SEMI_SNAPSHOT_FILE = prior;
    }
  });
});
