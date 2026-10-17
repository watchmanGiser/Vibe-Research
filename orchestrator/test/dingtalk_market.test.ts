import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { opinionStocks, parseMarketQuote, addHistory, DingTalkMarketData, buildDingTalkMarketFeed } from '../src/finance/dingtalk_market.ts';
const now = Date.parse('2026-10-17T04:00:00Z');
const opinion = { id: 'a'.repeat(64), title: 'CoreWeave信用风险', summary: '私人资料仅在本机保留。', keyPoints: ['股价独立补充'] };
const stock = opinionStocks(opinion)[0]!;
function quoteText(overrides: Record<number, string> = {}) {
  const fields = Array(74).fill('');
  Object.assign(fields, { 1: 'CoreWeave', 2: 'CRWV.OQ', 3: '100', 4: '90.91', 30: '2026-10-16 16:00:02', 32: '10.00' }, overrides);
  return `v_usCRWV="${fields.join('~')}";`;
}
function history() {
  const rows: string[][] = [];
  for (let d = new Date('2026-10-16T00:00:00Z'); rows.length < 25; d.setUTCDate(d.getUTCDate() - 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) rows.unshift([d.toISOString().slice(0, 10), '100', '100']);
  }
  rows[19]![2] = '80'; rows[4]![2] = '50';
  return { data: { 'usCRWV.OQ': { day: rows } } };
}
test('识别明确公司并优先标题主体；不把英文子串、提高意识或串并联特性当公司', () => {
  assert.equal(stock.symbol, 'CRWV'); assert.equal(stock.market, 'US');
  assert.deepEqual(opinionStocks({ ...opinion, title: '其他资料', summary: 'NotCoreWeave提高意识，关注串并联特性。', keyPoints: [] }), []);
  assert.deepEqual(opinionStocks({ ...opinion, title: '食品与研究方法', summary: '苹果期货震荡，小米粮食批发价上涨。使用 meta-analysis 方法汇总数据。', keyPoints: [] }), []);
  for (const summary of ['使用 meta-analysis 方法整理 Cometa公司的数据。', 'Apple 果汁涨价，Pineapple公司发布财报。']) {
    assert.deepEqual(opinionStocks({ ...opinion, title: '其他研究', summary, keyPoints: [] }), []);
  }
  for (const [text, symbol] of [['苹果股价上涨', 'AAPL'], ['小米手机业务', '01810'], ['Meta资本开支', 'META'], ['Meta Platforms财报', 'META']]) {
    assert.equal(opinionStocks({ ...opinion, title: text!, summary: '', keyPoints: [] })[0]?.symbol, symbol);
  }
  const found = opinionStocks({ ...opinion, summary: '英伟达、微软、谷歌、亚马逊均有讨论' });
  assert.equal(found[0]!.symbol, 'CRWV'); assert.equal(found.length, 4);
});
test('价格、单日与5/20交易日确定性计算，复权口径和行情交易日明确', () => {
  const quote = parseMarketQuote(quoteText(), stock, now);
  assert.equal(quote.price, 100); assert.equal(quote.dayPct, 10); assert.equal(quote.quoteTime, '2026-10-16 16:00:02');
  const value = addHistory(quote, history(), quote.historyKey);
  assert.equal(value.fiveDayPct, 25); assert.equal(value.twentyDayPct, 100); assert.equal(value.adjustment, '未复权');
  const raw = history(); const rows = raw.data['usCRWV.OQ'].day;
  const adjusted = addHistory(quote, { data: { 'usCRWV.OQ': { qfqday: rows } } }, quote.historyKey);
  assert.equal(adjusted.adjustment, '前复权');
  const short = addHistory(quote, { data: { 'usCRWV.OQ': { day: rows.slice(-4) } } }, quote.historyKey);
  assert.equal(short.fiveDayPct, null); assert.equal(short.twentyDayPct, null);
  const behind = addHistory(quote, { data: { 'usCRWV.OQ': { day: rows.slice(0, -1) } } }, quote.historyKey);
  assert.equal(behind.fiveDayPct, null); assert.match(behind.note!, /尚未更新/);
});
test('拒绝空价、错误标的和未来或无效日期；缺失涨跌幅不补零', () => {
  for (const overrides of [{ 3: '' }, { 3: '0' }, { 3: 'NaN' }, { 2: 'NVDA.OQ' }, { 30: '2026-10-18 16:00:00' }, { 30: '2026-02-30 16:00:00' }] as Array<Record<number, string>>) {
    assert.throws(() => parseMarketQuote(quoteText(overrides), stock, now));
  }
  assert.equal(parseMarketQuote(quoteText({ 32: '' }), stock, now).dayPct, null);
});
test('并发和重复资料共享行情缓存，保留原始响应；失败明确区分缓存和未获取', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-market-'));
  let at = now, fail = false; const urls: string[] = [];
  const transport = (async (input: string | URL | Request) => {
    const url = String(input); urls.push(url); if (fail) throw new Error('offline');
    return new Response(url.includes('qt.gtimg.cn') ? quoteText() : JSON.stringify(history()));
  }) as typeof fetch;
  try {
    const provider = new DingTalkMarketData(directory, transport, () => at);
    const [a, b] = await Promise.all([provider.get(stock), provider.get(stock)]);
    assert.deepEqual(a, b); assert.equal(urls.length, 2);
    const feed = await buildDingTalkMarketFeed([opinion, { ...opinion, id: 'b'.repeat(64) }], provider);
    assert.equal(urls.length, 2); assert.equal(Object.keys(feed.quotes).length, 1); assert.equal(Object.keys(feed.byOpinionId).length, 2);
    assert.ok(urls.every(url => !url.includes('私人') && !url.includes(opinion.id)));
    assert.equal(fs.readdirSync(path.join(directory, 'raw')).length, 2);
    const afterRestart = new DingTalkMarketData(directory, transport, () => at);
    assert.deepEqual(await afterRestart.get(stock), a); assert.equal(urls.length, 2);
    at += 300001; fail = true;
    const stale = await provider.get(stock); assert.equal(stale.status, 'stale'); assert.equal(stale.price, 100); assert.match(stale.note!, /更新失败/);
    const cold = new DingTalkMarketData(path.join(directory, 'cold'), transport, () => at);
    const unavailable = await cold.get(stock); assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.price, null);
    assert.equal(unavailable.dayPct, null); assert.equal(unavailable.fiveDayPct, null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
