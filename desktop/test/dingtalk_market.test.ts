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


test('多只股票共用一行列标题，按股票逐行显示，并合并相同行情时间', async () => {
  await withRenderer(async r => {
    const { DingTalkStockPerformance } = await r.load('/src/verticals/finance/components/DingTalkStockPerformance.tsx');
    const second = { ...quote, key: 'usNVDA', name: '英伟达', symbol: 'NVDA', price: 214.13, dayPct: -1.43, fiveDayPct: -6.61, twentyDayPct: -3.66 };
    const html = r.html(DingTalkStockPerformance, { quotes: [quote, second] });
    const text = textOf(html);
    assert.match(html, /aria-label="多只股票股价表现"/);
    assert.equal((html.match(/scope="col"/g) ?? []).length, 5);
    assert.equal((html.match(/scope="row"/g) ?? []).length, 2);
    for (const heading of ['股票', '最新价', '当日', '近5日', '近20日']) assert.equal((text.match(new RegExp(heading, 'g')) ?? []).length, 1, heading);
    for (const value of ['CoreWeave', 'CRWV', '61.39', '-11.91%', '英伟达', 'NVDA', '214.13', '-1.43%', '-6.61%', '-3.66%']) assert.ok(text.includes(value), value);
    assert.equal((text.match(/截至 2026-10-16 16:00:02（纽约时间）/g) ?? []).length, 1);
    assert.doesNotMatch(text, /腾讯财经|区间未复权|5\/20日指交易日/);
  });
});
test('多股票表格保留不同市场的时间、缓存警告及未获取状态', async () => {
  await withRenderer(async r => {
    const { DingTalkStockPerformance } = await r.load('/src/verticals/finance/components/DingTalkStockPerformance.tsx');
    const cached = { ...quote, key: 'sz300757', name: '罗博特科', symbol: '300757', market: 'CN', currency: 'CNY', status: 'stale', price: 442.5, quoteTime: '2026-10-16 16:14:18', note: '本次更新失败，显示上次成功获取的行情' };
    const missing = { ...quote, key: 'usASML', name: '阿斯麦', symbol: 'ASML', status: 'unavailable', price: 12345.67, note: '暂未获取最新行情' };
    const html = r.html(DingTalkStockPerformance, { quotes: [quote, cached, missing] });
    const text = textOf(html);
    assert.equal((html.match(/scope="row"/g) ?? []).length, 3);
    for (const value of ['CoreWeave：截至 2026-10-16 16:00:02（纽约时间）', '罗博特科：截至 2026-10-16 16:14:18（北京时间）', '缓存行情', '本次更新失败', '阿斯麦', '暂未获取最新行情']) assert.ok(text.includes(value), value);
    assert.doesNotMatch(text, /12345\.67|阿斯麦：截至/);
  });
});
