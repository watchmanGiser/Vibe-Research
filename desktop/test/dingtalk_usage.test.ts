import test from 'node:test';
import assert from 'node:assert/strict';
import { withRenderer, textOf } from './helpers/render.ts';
const usage = { schemaVersion: 1, date: '2026-10-14', limit: 200, used: 28, remaining: 172, latestAt: '2026-10-14T14:45:00Z', latestStatus: 'running', updatedAt: '2026-10-14T14:46:00Z' };

test('右上角显示实际最新调用、已用次数和剩余额度，失败次数不伪装为成功条数', async () => {
  await withRenderer(async r => {
    const { DingTalkUsageView } = await r.load('/src/verticals/finance/components/DingTalkUsageBadge.tsx');
    const html = r.html(DingTalkUsageView, { usage, now: Date.parse('2026-10-14T14:47:00Z') });
    const text = textOf(html);
    assert.match(text, /本地 GPT 整理/); assert.match(text, /最新 22:45 · 处理中/);
    assert.match(text, /今日已用 28 \/ 200 次/); assert.match(text, /还剩 172 次/);
    assert.match(html, /失败和超时也计入已用次数/);
  });
});

test('日切和统计不可用时不给出假的今日零用量，拒绝不一致统计', async () => {
  await withRenderer(async r => {
    const { DingTalkUsageView, parseDingTalkUsage } = await r.load('/src/verticals/finance/components/DingTalkUsageBadge.tsx');
    const old = textOf(r.html(DingTalkUsageView, { usage, now: Date.parse('2026-10-14T16:01:00Z') }));
    assert.match(old, /今日调用情况待同步/); assert.doesNotMatch(old, /今日已用|还剩/);
    const missing = textOf(r.html(DingTalkUsageView, { usage: null, unavailable: true }));
    assert.match(missing, /统计暂不可用/); assert.doesNotMatch(missing, /0 \/ 200|还剩/);
    assert.throws(() => parseDingTalkUsage({ ...usage, remaining: 199 }));
    assert.throws(() => parseDingTalkUsage({ ...usage, latestStatus: ['running'] }));
  });
});
