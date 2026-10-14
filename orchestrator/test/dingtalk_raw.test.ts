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

test('整页模式一次返回全部原文，超过旧限制的历史仍可搜索和定位', async () => {
  await withSnapshot(file => {
    const messages = Array.from({ length: 551 }, (_, i) => message(i));
    messages[0]!.text = '完整长篇原文\n'.repeat(1500) + '原文末尾不可截断';
    fs.writeFileSync(file, JSON.stringify(snapshot(messages)));
    const all = fetchDingTalkMessages(new URLSearchParams({ all: '1', limit: '1', offset: '400' }));
    assert.equal(all.messages.length, 551);
    assert.equal(all.total, 551);
    assert.equal(all.filteredTotal, 551);
    assert.equal(all.hasMore, false);
    assert.equal(all.offset, 0);
    assert.equal(all.limit, 551);
    assert.equal(all.messages.find(m => m.id === messages[0]!.id)!.text, messages[0]!.text);
    const search = fetchDingTalkMessages(new URLSearchParams({ all: '1', q: '原文末尾不可截断' }));
    assert.equal(search.messages.length, 1);
    assert.equal(search.messages[0]!.id, messages[0]!.id);
    const focused = fetchDingTalkMessages(new URLSearchParams({ all: '1', id: messages[0]!.id }));
    assert.equal(focused.messages.length, 1);
    assert.equal(focused.hasMore, false);
  });
});

test('兼容无配图的旧原文；仅接受原文对应的本站图片路径，拒绝临时授权网址', async () => {
  await withSnapshot(file => {
    const original = '原文\n\n[图片消息](mediaId= @real-image )';
    const image = { reference: '@real-image', url: `/dingtalk/media/${'a'.repeat(64)}.jpg` };
    const item = { ...message(1), text: original, images: [image] };
    fs.writeFileSync(file, JSON.stringify(snapshot([item])));
    const result = fetchDingTalkMessages();
    assert.deepEqual(result.messages[0]!.images, [image]);
    assert.equal(result.messages[0]!.text, original);
    for (const images of [[{ ...image, url: 'https://example.com/image.jpg?token=private' }], [{ ...image, url: '/dingtalk/media/../../secret' }], [{ ...image, reference: '@other-image' }], [{ ...image, token: 'private' }], 'invalid']) {
      const invalid = { ...item, images };
      fs.writeFileSync(file, JSON.stringify(snapshot([invalid])));
      assert.throws(() => fetchDingTalkMessages(), DingTalkSnapshotError);
    }
  });
});

test('原始版本保留、可搜索且可沿重复 ID 定位；拒绝版本中的私有字段', async()=>{
 await withSnapshot(file=>{
  const primary=message(1),copy=message(2);
  const version={id:copy.id,time:copy.time,sender:'其他发送者',text:'括号补充内容'};
  const item={...primary,relatedIds:[primary.id,copy.id],versions:[version]};
  fs.writeFileSync(file,JSON.stringify(snapshot([item])));
  assert.deepEqual(fetchDingTalkMessages(new URLSearchParams({id:copy.id})).messages[0]!.versions,[version]);
  assert.equal(fetchDingTalkMessages(new URLSearchParams({q:'括号补充'})).messages.length,1);
  for(const versions of [[{...version,conversationId:'private'}],[{...version,id:id('unrelated')}],[{...version,time:'invalid'}]]){
   const invalid={...item,versions};fs.writeFileSync(file,JSON.stringify(snapshot([invalid])));assert.throws(()=>fetchDingTalkMessages(),DingTalkSnapshotError);
  }
 });
});

test('文档缓存元信息随原文返回，拒绝无来源或跨站预览地址', async () => {
  await withSnapshot(file => {
    const reference = 'https://pushmedia.oss-cn-beijing.aliyuncs.com/research.pdf';
    const fingerprint = id('file');
    const document = { id: id(reference), name: '研究.pdf', kind: 'pdf', status: 'ready',
      url: `/dingtalk/documents/${fingerprint}.pdf`, textUrl: `/dingtalk/documents/${fingerprint}.txt`,
      previewUrl: `/dingtalk/documents/${fingerprint}.pdf`, pageCount: 2, previewImages: [`/dingtalk/documents/${fingerprint}-page-001.jpg`] };
    const source = { id: id('document'), time: '2026-10-14 10:00:00', sender: '测试', text: `[研究.pdf](${reference})`, duplicateCount: 0,
      relatedIds: [id('document')], latestDuplicateTime: null, documents: [document] };
    const write = (item: object) => fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, label: '击球区原始消息', syncedAt: '2026-10-14T03:00:00Z', duplicateCount: 0, messages: [item] }));
    write(source);
    assert.equal(fetchDingTalkMessages().messages[0]!.documents![0]!.pageCount, 2);
    for (const changed of [{ ...document, id: id('unrelated') }, { ...document, textUrl: 'https://example.com/secret.txt' },
      { ...document, previewImages: [`/dingtalk/documents/${id('another')}-page-001.jpg`] }, { ...document, kind: 'html' }, { ...document, kind: ['pdf'] }, { id: document.id, name: document.name, kind: 'pdf', status: ['ready'] }]) {
      write({ ...source, documents: [changed] }); assert.throws(() => fetchDingTalkMessages());
    }
  });
});
