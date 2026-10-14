import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { UsageLedger, digest } from '../dingtalk-jobs.mjs';
import { callCodex, callResponses } from '../dingtalk-model.mjs';

test('流式完成事件实时留账；成功后的上游重试警告不会导致重复整理', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-model-'));
  try {
    const ledger = new UsageLedger(path.join(root, 'usage.jsonl'), 'scope');
    const code = `process.stderr.write('retry after HTTP 502\\n'); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10000,cached_input_tokens:8000,output_tokens:200}}));`;
    await callCodex({ bin: process.execPath, args: ['-e', code], input: 'fixture', timeout: 1000, ledger, jobId: digest('one') });
    assert.equal(ledger.stats().knownTokens, 10200); assert.equal(ledger.stats().unknownCalls, 0);
    assert.equal([...ledger.calls.values()][0].success, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('超时会清理子孙进程，账本保留未知用量', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-model-timeout-'));
  try {
    const ledger = new UsageLedger(path.join(root, 'usage.jsonl'), 'scope'), heartbeat = path.join(root, 'heartbeat');
    const grandchild = `const fs=require('node:fs'); setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),10);`;
    const parent = `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}); setInterval(()=>{},1000);`;
    await assert.rejects(callCodex({ bin: process.execPath, args: ['-e', parent], input: '', timeout: 300, killGrace: 50, ledger, jobId: digest('two') }), error => error.code === 'MODEL_TIMEOUT');
    const before = fs.readFileSync(heartbeat, 'utf8'); await delay(100);
    assert.equal(fs.readFileSync(heartbeat, 'utf8'), before, '被终止的后代进程不能继续工作');
    assert.equal(ledger.stats().unknownCalls, 1);
    assert.equal([...ledger.calls.values()][0].errorCode, 'MODEL_TIMEOUT');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('直接 Responses 支持图片、结构化输出及缓存用量；失败不自动重发', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-api-'));
  const requests = []; let failure = false;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    if (failure) { res.writeHead(429).end('{}'); return; }
    res.setHeader('Content-Type', 'application/json'); res.setHeader('x-request-id', 'req-fixture');
    res.end(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"title":"图片事件"}' }] }],
      usage: { input_tokens: 10000, input_tokens_details: { cached_tokens: 8000 }, output_tokens: 200 } }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const image = path.join(root, 'image.png'); fs.writeFileSync(image, 'fixture-image');
    const ledger = new UsageLedger(path.join(root, 'usage.jsonl'), 'scope'), apiKey = randomBytes(16).toString('hex');
    const options = { endpoint: `http://127.0.0.1:${server.address().port}/v1/responses`, apiKey, model: 'fixture-model', reasoning: 'medium', input: '图片资料', images: [image], schema: { type: 'object', properties: {} }, timeout: 1000, ledger, jobId: digest('three') };
    assert.equal(await callResponses(options), '{"title":"图片事件"}');
    assert.equal(requests[0].input[0].content[1].type, 'input_image');
    assert.equal(requests[0].text.format.type, 'json_schema'); assert.equal(requests[0].store, false);
    assert.equal(ledger.stats().knownTokens, 10200); assert.equal(ledger.stats().unknownCalls, 0);
    assert.equal(fs.readFileSync(ledger.file, 'utf8').includes(apiKey), false);
    failure = true; await assert.rejects(callResponses(options), error => error.code === 'RATE_LIMIT');
    assert.equal(requests.length, 2, '一次失败只能对应一次上游请求');
    assert.equal(ledger.stats().unknownCalls, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});

test('多个完成事件聚合时，每个 usage 都只能保存统计字段', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-usage-multi-'));
  try {
    const ledger = new UsageLedger(path.join(root, 'usage.jsonl'), 'scope');
    const code = `for(let i=0;i<2;i++)console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10000,cached_input_tokens:8000,output_tokens:200,non_statistics_field:'synthetic-do-not-store'}}));`;
    await callCodex({ bin: process.execPath, args: ['-e', code], input: '', timeout: 1000, ledger, jobId: digest('multiple') });
    assert.equal(ledger.stats().knownTokens, 20400);
    assert.doesNotMatch(fs.readFileSync(ledger.file, 'utf8'), /non_statistics_field|synthetic-do-not-store/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
