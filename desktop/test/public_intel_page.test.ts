import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicDingTalkPage, prepareFinancePage } from '../src/verticals/finance/lib/publicIntelPage.ts';

test('公开钉钉页无需读取个人资料即可启动', async () => {
  let reads = 0;
  const denied = async () => { reads++; throw Error('个人资料不可读'); };
  const publicMode = await prepareFinancePage('/vibe-research/intel/dingtalk', '/vibe-research/', denied, denied);
  assert.equal(publicMode, true);
  assert.equal(reads, 0);
  assert.equal(isPublicDingTalkPage('/vibe-research/intel/dingtalk/', '/vibe-research/'), true);
});

test('个人页面先读取真实台账，本地默认路径继续按原规则启动', async () => {
  const calls: string[] = [];
  assert.equal(await prepareFinancePage('/vibe-research/my-stocks', '/vibe-research/', async () => { calls.push('notes'); }, async () => { calls.push('watch'); }), false);
  assert.deepEqual(calls, ['notes', 'watch']);
  assert.equal(isPublicDingTalkPage('/intel/dingtalk', '/'), false);
  assert.equal(isPublicDingTalkPage('/vibe-research/intel/dingtalk-other', '/vibe-research/'), false);
  assert.equal(isPublicDingTalkPage('/vibe-research/settings', '/vibe-research/'), false);
});

test('个人台账读取失败仍中止启动，不能退化为成功的空资料', async () => {
  await assert.rejects(prepareFinancePage('/vibe-research/my-stocks', '/vibe-research/', async () => { throw Error('真实台账读取失败'); }, async () => {}), /真实台账读取失败/);
});
