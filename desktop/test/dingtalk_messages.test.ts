import test from 'node:test';
import assert from 'node:assert/strict';
import { withRenderer, textOf } from './helpers/render.ts';

test('原文卡片保留长文最后一句、发送者与重复计数，提供展开全文入口', async () => {
  await withRenderer(async r => {
    const { DingTalkMessageCard } = await r.load('/src/verticals/finance/pages/SemiPanels.tsx');
    const body = '长篇消息\n'.repeat(1000) + '必须保留的最后一句';
    const html = r.html(DingTalkMessageCard, { item: { id: 'a'.repeat(64), time: '2026-10-13T02:00:00Z', sender: '测试发送者', text: body, duplicateCount: 2, relatedIds: ['a'.repeat(64)], latestDuplicateTime: null } });
    const visible = textOf(html);
    assert.match(visible, /必须保留的最后一句/); assert.match(visible, /测试发送者/); assert.match(visible, /已合并 2 条重复/);
    assert.match(visible, /展开全文/); assert.match(visible, /10:00:00/);
  });
});

test('短消息直接显示全文，原文中的 HTML 不会作为网页执行', async () => {
  await withRenderer(async r => {
    const { DingTalkMessageCard } = await r.load('/src/verticals/finance/pages/SemiPanels.tsx');
    const html = r.html(DingTalkMessageCard, { item: { id: 'b'.repeat(64), time: '2026-10-13 10:00:00', sender: '甲', text: '<script>原文内容</script>', duplicateCount: 0, relatedIds: ['b'.repeat(64)], latestDuplicateTime: null } });
    assert.ok(html.includes('&lt;script&gt;原文内容&lt;/script&gt;'));
    assert.doesNotMatch(html, /<script>|展开全文|已合并/);
  });
});
