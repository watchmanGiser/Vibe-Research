import test from 'node:test';
import assert from 'node:assert/strict';
import { withRenderer, textOf } from './helpers/render.ts';
const quote = { key: 'usCRWV', symbol: 'CRWV', name: 'CoreWeave', market: 'US', currency: 'USD', timezone: 'America/New_York',
  status: 'ok', price: 61.39, dayPct: -11.91, fiveDayPct: -25.2, twentyDayPct: null,
  quoteTime: '2026-10-16 16:00:02', fetchedAt: '2026-10-17T04:00:00Z', source: '腾讯财经', sourceUrl: 'https://gu.qq.com/usCRWV', adjustment: '未复权', note: null };
test('整理卡片显示独立行情区块、币种与简洁行情时间', async () => {
  await withRenderer(async r => {
    const { DingTalkSummaryCard } = await r.load('/src/verticals/finance/pages/SemiPanels.tsx');
    const item = { id: 'a'.repeat(64), time: '2026-10-15 06:36:31', kind: 'opinion', title: 'CoreWeave信用风险', summary: '原资料观点保留。', keyPoints: ['资料观点不变'], caveats: ['信用判断待核验'] };
    const html = r.html(DingTalkSummaryCard, { item, onShowOriginal: () => {}, stockQuotes: [quote] });
    const text = textOf(html);
    for (const expected of ['原资料观点保留', '资料观点不变', '信用判断待核验', '股价表现', 'CRWV', '美股', '61.39 美元', '-11.91%', '-25.20%', '近20日', '截至 2026-10-16 16:00:02（纽约时间）']) assert.ok(text.includes(expected), expected);
    assert.doesNotMatch(text, /腾讯财经|区间未复权|5\/20日指交易日/);
    assert.match(text, /近20日 —/); assert.doesNotMatch(text, /0\.00%/);
  });
});
test('行情失效或未获取时显示真实状态；没有匹配公司时不生成空行情区块', async () => {
  await withRenderer(async r => {
    const { DingTalkStockPerformance } = await r.load('/src/verticals/finance/components/DingTalkStockPerformance.tsx');
    assert.equal(r.html(DingTalkStockPerformance, { quotes: [] }), '');
    const stale = textOf(r.html(DingTalkStockPerformance, { quotes: [{ ...quote, status: 'stale', note: '本次更新失败，显示上次成功获取的行情' }] }));
    assert.match(stale, /缓存行情/); assert.match(stale, /本次更新失败/); assert.match(stale, /2026-10-16/);
    const missing = textOf(r.html(DingTalkStockPerformance, { quotes: [{ ...quote, status: 'unavailable', price: null, note: '暂未获取最新行情' }] }));
    assert.match(missing, /暂未获取最新行情/); assert.doesNotMatch(missing, /61\.39|0\.00%/);
  });
});
