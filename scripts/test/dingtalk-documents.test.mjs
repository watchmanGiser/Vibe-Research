import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cacheMessageDocuments, messageDocumentReferences } from '../dingtalk-documents.mjs';
import { buildRawFeed } from '../publish-dingtalk-raw.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const link = 'https://pushmedia.oss-cn-beijing.aliyuncs.com/fixture.pdf';
const bytes = Buffer.from('%PDF-1.7\nfixture');
const raw = (text = `[研究.pdf](${link})`) => ({ conversationId: 'documents-test', syncedAt: '2026-10-14T02:00:00Z', duplicateCount: 0,
  messages: [{ messageId: 'document-message', sender: '测试发送者', time: '2026-10-14 10:00:00', text, duplicateCount: 0 }] });
const text = '文件正文：2026年收入预计增长15%，报价1.5元。这里是实际下载文件中的正文和表格数据。';
function parsed(file, directory) {
  const stem = path.basename(file).split('.')[0];
  const textFile = stem + '.txt', page = stem + '-page-001.jpg';
  fs.writeFileSync(path.join(directory, textFile), text);
  fs.writeFileSync(path.join(directory, page), Buffer.from('ffd8ffe0', 'hex'));
  return { textFile, previewFile: path.basename(file), pageImages: [page], pageCount: 1, previewPageCount: 1, textChars: text.length, parser: 'fixture' };
}
async function fixture(check) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-documents-test-'));
  try { await check({ directory, env: { ...process.env, DINGTALK_CONVERSATION_ID: 'documents-test', DINGTALK_DOCUMENT_CACHE_DIR: directory } }); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('识别文档链接、Markdown文件名和带查询参数的网址，过滤非文档及危险协议', () => {
  const references = messageDocumentReferences(`[研究.pdf](${link})\n${link}\n[Word.docx](https://pushmedia.oss-cn-beijing.aliyuncs.com/resource?id=2)\nhttps://example.com/report.pdf?sign=test\n[危险.pdf](javascript:evil)\nhttps://example.com/image.jpg`);
  assert.equal(references.length, 3);
  assert.equal(references[0].name, '研究.pdf');
  assert.equal(references[1].kind, 'docx');
  assert.equal(references[2].id, hash('https://example.com/report.pdf?sign=test'));
});

test('真实下载按内容哈希缓存，重启复用正文和逐页预览，索引不记录网址及授权参数', async () => fixture(async ({ directory, env }) => {
  let downloads = 0, parses = 0;
  const options = { fetch: async (_url, config) => { downloads++; assert.equal(config.redirect, 'error'); return new Response(bytes); },
    parse: async (file, target) => { parses++; return parsed(file, target); } };
  const result = await cacheMessageDocuments(raw(), env, options);
  assert.equal(result.ready, 1); assert.equal(result.unavailable, 0);
  assert.equal(result.texts.get(hash(link)), text);
  assert.deepEqual(fs.readFileSync(path.join(directory, hash(bytes) + '.pdf')), bytes);
  assert.equal(result.documents.get(hash(link)).previewImages.length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'), /https|sign=|fixture\.pdf/);
  const again = await cacheMessageDocuments(raw(), env, options);
  assert.equal(again.ready, 1); assert.equal(downloads, 1); assert.equal(parses, 1);
  const feed = buildRawFeed(raw(), 'documents-test', new Map(), result.documents);
  assert.equal(feed.messages[0].text, raw().messages[0].text);
  assert.equal(feed.messages[0].documents[0].status, 'ready');
}));

test('禁止任意来源下载；下载失败持久退避，解析失败仍保留原文件', async () => fixture(async ({ directory, env }) => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response('', { status: 403 }); };
  const denied = await cacheMessageDocuments(raw('https://127.0.0.1/internal.pdf'), env, { fetch: fetcher });
  assert.equal(denied.documents.values().next().value.status, 'unsupported'); assert.equal(calls, 0);
  const failed = await cacheMessageDocuments(raw(), env, { fetch: fetcher });
  assert.equal(failed.ready, 0); assert.equal(failed.documents.get(hash(link)).status, 'download_failed');
  await cacheMessageDocuments(raw(), env, { fetch: fetcher }); assert.equal(calls, 1, '重启也必须遵守冷却');
  const index = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'))); index.entries[hash(link)].nextRetryAt = 0;
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(index));
  const broken = await cacheMessageDocuments(raw(), env, { fetch: async () => new Response(bytes), parse: () => { throw Error('parse failed'); } });
  assert.equal(broken.documents.get(hash(link)).status, 'parse_failed');
  assert.ok(broken.documents.get(hash(link)).url.endsWith('.pdf')); assert.equal(broken.texts.size, 0);
}));

test('拒绝伪装文档和越界解析产物，离线整理不重新下载', async () => fixture(async ({ directory, env }) => {
  const invalid = await cacheMessageDocuments(raw(), env, { fetch: async () => new Response('<html>bad</html>'), parse: parsed });
  assert.equal(invalid.documents.get(hash(link)).status, 'download_failed');
  const offline = await cacheMessageDocuments(raw(), env, { download: false, fetch: () => { throw Error('不能下载'); } });
  assert.equal(offline.ready, 0); assert.equal(offline.unavailable, 1);
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.pdf')).length, 0);
  const outside = await cacheMessageDocuments(raw('https://pushmedia.oss-cn-beijing.aliyuncs.com/other.pdf'), env, { fetch: async () => new Response(bytes), parse: () => ({ textFile: '../secret.txt', pageImages: [], pageCount: 1, textChars: 100 }) });
  assert.equal([...outside.documents.values()][0].status, 'parse_failed');
  assert.equal(outside.texts.size, 0);
  assert.ok(outside.filenames.every(name => !name.includes('..')));
}));

test('正文或预览内容损坏时拒绝复用；重新解析生成新版本URL并更新发布指纹', async () => fixture(async ({ directory, env }) => {
  let downloads = 0;
  const options = { fetch: async () => { downloads++; return new Response(bytes); }, parse: parsed };
  const first = await cacheMessageDocuments(raw(), env, options);
  const initial = first.documents.get(hash(link));
  const textFile = initial.textUrl.split('/').at(-1);
  fs.writeFileSync(path.join(directory, textFile), '');
  const damaged = await cacheMessageDocuments(raw(), env, { download: false });
  assert.equal(damaged.ready, 0); assert.equal(damaged.documents.get(hash(link)).status, 'parse_failed');
  const repaired = await cacheMessageDocuments(raw(), env, options);
  assert.equal(repaired.ready, 1); assert.equal(downloads, 1, '保留经过校验的原文件，不重复下载');
  const image = repaired.documents.get(hash(link)).previewImages[0].split('/').at(-1);
  fs.writeFileSync(path.join(directory, image), Buffer.from('damaged image'));
  assert.equal((await cacheMessageDocuments(raw(), env, { download: false })).ready, 0);
  const changed = await cacheMessageDocuments(raw(), env, { ...options, parse: (file, stage) => {
    const result = parsed(file, stage);
    const body = text + '\n重新解析补充的文档正文。';
    fs.writeFileSync(path.join(stage, result.textFile), body); result.textChars = body.length; return result;
  } });
  assert.equal(changed.ready, 1);
  assert.notEqual(changed.documents.get(hash(link)).textUrl, initial.textUrl);
  assert.notEqual(changed.publicationHash, first.publicationHash);
  assert.ok(changed.filenames.every(name => !name.startsWith('.parse-') && name !== 'index.json'));
}));

test('部分扫描页未识别时保留下载和预览，禁止不完整正文进入整理', async () => fixture(async ({ env }) => {
  const result = await cacheMessageDocuments(raw(), env, { fetch: async () => new Response(bytes), parse: (file, stage) => ({ ...parsed(file, stage), unreadablePages: [1] }) });
  const document = result.documents.get(hash(link));
  assert.equal(document.status, 'partial'); assert.ok(document.textUrl); assert.ok(document.previewImages.length);
  assert.deepEqual(document.unreadablePages, [1]); assert.equal(result.ready, 0); assert.equal(result.texts.size, 0);
}));

test('原文发布在正文重新解析后上传新版本，不会误判为无新增内容', async () => fixture(async ({ directory, env }) => {
  const { publishRawFeed } = await import('../publish-dingtalk-raw.mjs');
  const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(directory, 'uploads'), source = path.join(directory, 'raw.json'), key = path.join(directory, 'key');
  fs.writeFileSync(source, JSON.stringify(raw())); fs.writeFileSync(key, 'fixture');
  fs.writeFileSync(path.join(bin, 'scp'), `#!/usr/bin/env node
const fs=require('node:fs'); fs.appendFileSync(process.env.TEST_UPLOADS,JSON.stringify({name:require('node:path').basename(process.argv.at(-2)),files:process.argv.includes('-r')?fs.readdirSync(process.argv.at(-2)):[]})+'\\n');`, {mode:0o700});
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nexit 0\n', {mode:0o700});
  const options={fetch:async()=>new Response(bytes),parse:parsed};
  const first=await cacheMessageDocuments(raw(),env,options);
  const publishEnv={...env,PATH:bin+':'+process.env.PATH,DINGTALK_LOCAL_SNAPSHOT_FILE:source,DINGTALK_PUSH_HOST:'fixture.invalid',DINGTALK_PUSH_SSH_KEY:key,TEST_UPLOADS:calls};
  await publishRawFeed(publishEnv);
  assert.equal(fs.readFileSync(calls,'utf8').trim().split('\n').length,2);
  const initial=first.documents.get(hash(link));
  fs.unlinkSync(path.join(directory,initial.previewImages[0].split('/').at(-1)));
  const changed=await cacheMessageDocuments(raw(),env,{...options,parse:(file,stage)=>{
    const result=parsed(file,stage);const body=text+'\n新增识别正文的版本。';fs.writeFileSync(path.join(stage,result.textFile),body);return result;
  }});
  assert.notEqual(changed.documents.get(hash(link)).textUrl,initial.textUrl);
  await publishRawFeed(publishEnv);
  const records=fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length,4,'第二次必须重新上传文档与快照');
  assert.ok(records.filter(item=>item.files.length).every(item=>item.files.every(name=>name!=='index.json'&&!name.startsWith('.'))));
}));

test('第三次成功的旧缓存只迁移解析一次，不重复下载也不解除真实失败的上限', async () => fixture(async ({ directory, env }) => {
  const file=hash(bytes)+'.pdf';fs.writeFileSync(path.join(directory,file),bytes);
  const legacy={...parsed(path.join(directory,file),directory),file,status:'ready',attempts:3};
  fs.writeFileSync(path.join(directory,'index.json'),JSON.stringify({schemaVersion:1,conversationHash:hash('documents-test'),entries:{[hash(link)]:legacy}}));
  let parses=0;
  const options={fetch:()=>{throw Error('不得重复下载原文件');},parse:(source,stage)=>{parses++;return parsed(source,stage);}};
  const result=await cacheMessageDocuments(raw(),env,options);
  assert.equal(result.ready,1);assert.equal(parses,1);
  await cacheMessageDocuments(raw(),env,options);assert.equal(parses,1,'新格式缓存应直接复用');
  const index=JSON.parse(fs.readFileSync(path.join(directory,'index.json')));
  index.entries[hash(link)]={status:'download_failed',attempts:3};
  fs.writeFileSync(path.join(directory,'index.json'),JSON.stringify(index));
  const failed=await cacheMessageDocuments(raw(),env,options);
  assert.equal(failed.ready,0);assert.equal(parses,1);assert.equal(failed.documents.get(hash(link)).status,'download_failed');
}));
