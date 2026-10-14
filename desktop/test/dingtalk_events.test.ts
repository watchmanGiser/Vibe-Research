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

test('研报显示机构归属和可读原页原文，不加待核验标签也不把预测变成事实', async () => {
  await withRenderer(async r => {
    const { DingTalkSummaryCard } = await r.load('/src/verticals/finance/pages/SemiPanels.tsx');
    const report = { ...notice, kind: 'research', title: '大摩OCP峰会要点', summary: '报告预计USFP商业化生产从2028年起开始。', caveats: ['所附原页未显示报告发布日期。'], report: { publisher: '摩根士丹利', title: 'Takeaways from 2026 OCP Global Summit', originalText: 'We expect commercial production to start from 2028 onwards.' } };
    const html = r.html(DingTalkSummaryCard, { item: report, onShowOriginal: () => {} });
    const text = textOf(html);
    assert.match(text, /研报内容 · 摩根士丹利/);
    assert.match(text, /Takeaways from 2026 OCP Global Summit/);
    assert.match(text, /预计.*2028/);
    assert.match(text, /We expect commercial production/);
    assert.match(text, /查看研报原文/);
    assert.match(text, /研报原文摘录/);
    assert.doesNotMatch(text, /待核验|待独立核验|第三方观点/);
    assert.doesNotMatch(html, /overflow-y-auto|max-h-/);
  });
});
