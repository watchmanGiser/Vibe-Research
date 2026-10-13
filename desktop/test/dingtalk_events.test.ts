import test from 'node:test';
import assert from 'node:assert/strict';
import { withRenderer, textOf } from './helpers/render.ts';
const notice = { id: 'a'.repeat(64), time: '2026-10-13T12:00:00Z', kind: 'event', title: '覆铜板价格调整通知', summary: '通知列明指定型号上调200%，2027年1月1日起出货执行。', keyPoints: ['R-1705全部规格，其余列示产品限厚度1.1毫米及以上。'], caveats: ['通知实施日期尚未到来。'] };

test('通知按事件显示，并保留可回看原图的原文入口', async () => {
  await withRenderer(async r => {
    const { DingTalkSummaryCard } = await r.load('/src/verticals/finance/pages/SemiPanels.tsx');
    const html = r.html(DingTalkSummaryCard, { item: notice, onShowOriginal: () => {} });
    const text = textOf(html);
    assert.match(text, /事件记录/);
    assert.match(text, /200%.*2027年1月1日/);
    assert.match(text, /补充说明/);
    assert.match(text, /查看对应原文/);
    assert.doesNotMatch(text, /第三方观点|风险 \/ 待核验/);
  });
});

test('旧观点保留观点标识与必要的风险提示', async () => {
  await withRenderer(async r => {
    const { DingTalkSummaryCard } = await r.load('/src/verticals/finance/pages/SemiPanels.tsx');
    const { kind, ...legacy } = notice;
    const text = textOf(r.html(DingTalkSummaryCard, { item: { ...legacy, title: '行业需求判断', caveats: ['缺少独立数据。'] }, onShowOriginal: () => {} }));
    assert.match(text, /第三方观点，待独立核验/);
    assert.match(text, /风险 \/ 待核验/);
    assert.doesNotMatch(text, /事件记录/);
  });
});
