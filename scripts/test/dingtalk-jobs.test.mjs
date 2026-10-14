import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JobStore, UsageLedger, digest, contentFingerprint, acquireQueueLock, normalizedUsage } from '../dingtalk-jobs.mjs';
const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-jobs-'));

test('内容指纹忽略空行和不同媒体引用，保留数字、单位及图片实际变化', () => {
  const root = directory();
  try {
    const image = path.join(root, 'image.png'); fs.writeFileSync(image, 'image-one');
    const a = contentFingerprint('价格 1.5 元\n\n[图片消息](mediaId=@a)', [image], 'scope');
    assert.equal(a, contentFingerprint('价格 1.5 元\n[图片消息](mediaId=@b)', [image], 'scope'));
    assert.notEqual(a, contentFingerprint('价格 15 元\n[图片消息](mediaId=@b)', [image], 'scope'));
    fs.writeFileSync(image, 'image-two');
    assert.notEqual(a, contentFingerprint('价格 1.5 元\n[图片消息](mediaId=@a)', [image], 'scope'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('失败冷却和三次上限跨重启保存；处理中断仍消耗原尝试次数', () => {
  const root = directory(); let now = 0;
  try {
    const file = path.join(root, 'jobs.json'), id = digest('document');
    const load = () => new JobStore(file, 'scope', { now: () => now });
    let store = load(); assert.equal(store.begin(id), true); store.fail(id, 'MODEL_TIMEOUT');
    store = load(); assert.equal(store.due(id), false); assert.equal(store.ensure(id).attempts, 1);
    now = 1800000; assert.equal(store.begin(id), true);
    store = load(); store.recoverInterrupted();
    assert.equal(store.ensure(id).attempts, 2); assert.equal(store.due(id), false);
    now += 7200000; assert.equal(store.begin(id), true); store.fail(id, 'MODEL_TIMEOUT');
    store = load(); now += 86400000;
    assert.equal(store.due(id), false); assert.equal(store.ensure(id).status, 'failed');
    assert.equal(store.ensure(id).attempts, 3);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('队列锁跨进程排他；释放后可再进入，不依赖删除锁文件', () => {
  const root = directory();
  try {
    const file = path.join(root, 'jobs.lock'), release = acquireQueueLock(file);
    assert.equal(typeof release, 'function');
    const module = new URL('../dingtalk-jobs.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {acquireQueueLock} from ${JSON.stringify(module)}; const release=acquireQueueLock(process.argv[1]); console.log(Boolean(release)); release?.();`, file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'false');
    release(); const again = acquireQueueLock(file); assert.equal(typeof again, 'function'); again();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('CLI 和 Responses 缓存口径归一，不重复加缓存；不保存任意上游字段', () => {
  const cli = normalizedUsage({ input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 200, privateCredential: 'not-statistics' });
  const api = normalizedUsage({ input_tokens: 10000, input_tokens_details: { cached_tokens: 8000 }, output_tokens: 200 }, 'responses');
  assert.equal(cli.inputTokens, 2000); assert.equal(cli.cachedInputTokens, 8000); assert.equal(cli.totalTokens, 10200);
  assert.equal(api.totalTokens, cli.totalTokens); assert.equal(api.inputTokens, cli.inputTokens);
  assert.equal(JSON.stringify(cli).includes('privateCredential'), false);
  assert.equal(normalizedUsage({ input_tokens: 100, cached_input_tokens: 200, output_tokens: 1 }), null);
});
test('未完成调用记为未知，跨重启也占每日次数；用量事件和结束事件不会重复累计', () => {
  const root = directory();
  try {
    const file = path.join(root, 'usage.jsonl'), options = { callBudget: 2, tokenBudget: 20000 };
    let ledger = new UsageLedger(file, 'scope', options); ledger.start(digest('one'));
    ledger = new UsageLedger(file, 'scope', options); assert.equal(ledger.stats().unknownCalls, 1);
    const callId = ledger.start(digest('two'));
    const usage = normalizedUsage({ input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 200 });
    ledger.append({ event: 'usage', callId, usage, usageStatus: 'partial' });
    ledger.append({ event: 'finished', callId, usage, usageStatus: 'reported' });
    ledger = new UsageLedger(file, 'scope', options);
    assert.equal(ledger.stats().calls, 2); assert.equal(ledger.stats().knownTokens, 10200);
    assert.equal(ledger.stats().unknownCalls, 1); assert.equal(ledger.available(), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
