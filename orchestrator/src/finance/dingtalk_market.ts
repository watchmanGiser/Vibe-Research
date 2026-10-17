/** 击球区行情独立补充：只发送证券代码，不发送资料正文；原始响应留存于本机。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

type Market = 'US' | 'CN' | 'HK';
export interface MarketStock { key: string; symbol: string; name: string; market: Market; currency: 'USD' | 'CNY' | 'HKD'; timezone: string }
export interface StockPerformance extends MarketStock {
  status: 'ok' | 'stale' | 'unavailable'; price: number | null; dayPct: number | null;
  fiveDayPct: number | null; twentyDayPct: number | null; quoteTime: string | null;
  fetchedAt: string; source: string; sourceUrl: string; adjustment: string | null; note: string | null;
}
type Opinion = { id: string; title: string; summary: string; keyPoints: string[] };
export interface DingTalkMarketFeed { byOpinionId: Record<string, string[]>; quotes: Record<string, StockPerformance> }
const stocks: Array<MarketStock & { aliases: string[] }> = [];
function add(symbol: string, name: string, aliases: string[], market: Market = 'US') {
  const key = market === 'US' ? `us${symbol}` : market === 'HK' ? `hk${symbol}` : `${symbol.startsWith('6') ? 'sh' : 'sz'}${symbol}`;
  stocks.push({ key, symbol, name, aliases: [name, ...aliases], market, currency: market === 'US' ? 'USD' : market === 'HK' ? 'HKD' : 'CNY', timezone: market === 'US' ? 'America/New_York' : market === 'HK' ? 'Asia/Hong_Kong' : 'Asia/Shanghai' });
}
add('CRWV', 'CoreWeave', ['Core Weave']);
add('ASML', '阿斯麦', ['ASML']);
add('NVDA', '英伟达', ['NVIDIA']); add('GOOGL', 'Alphabet', ['谷歌', 'Google']);
add('MSFT', '微软', ['Microsoft']); add('AMZN', '亚马逊', ['Amazon']);
add('META', 'Meta Platforms', ['Meta', '脸书']); add('AAPL', '苹果公司', ['苹果', 'Apple', 'Apple Inc.']); add('TSLA', '特斯拉', ['Tesla']);
add('ORCL', '甲骨文', ['Oracle']); add('AMD', 'AMD', []); add('AVGO', '博通', ['Broadcom']);
add('PLTR', 'Palantir', ['帕兰提尔']); add('INTC', '英特尔', ['Intel']); add('MRVL', 'Marvell', ['迈威尔']);
add('COHR', 'Coherent', []); add('LITE', 'Lumentum', []); add('GLW', '康宁', ['Corning']);
add('MU', '美光', ['Micron']); add('ANET', 'Arista', ['阿里斯塔']); add('DELL', '戴尔', ['Dell']);
add('SMCI', '超微电脑', ['Supermicro']); add('IREN', 'IREN', []); add('NBIS', 'Nebius', []);
add('APLD', 'Applied Digital', []);
add('300308', '中际旭创', ['旭创'], 'CN'); add('300502', '新易盛', [], 'CN');
add('300394', '天孚通信', ['天孚'], 'CN'); add('300620', '光库科技', ['光库'], 'CN');
add('301205', '联特科技', [], 'CN'); add('300757', '罗博特科', [], 'CN');
add('688025', '杰普特', [], 'CN'); add('002281', '光迅科技', [], 'CN');
add('000988', '华工科技', [], 'CN'); add('300570', '太辰光', [], 'CN');
add('00700', '腾讯控股', ['腾讯'], 'HK'); add('01810', '小米集团', ['小米'], 'HK');
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentions(text: string, alias: string) {
  return /^[\x00-\x7f]+$/.test(alias) ? new RegExp(`(?<![A-Za-z0-9_])${escaped(alias)}(?![A-Za-z0-9_])`, 'i').test(text) : text.includes(alias);
}
const ambiguousAliases = new Set(['苹果', 'apple', '小米', 'xiaomi', 'meta', '腾讯', 'tencent']);
function mentionsCompany(text: string, stock: typeof stocks[number]) {
  return stock.aliases.some(alias => {
    if (!mentions(text, alias)) return false;
    if (!ambiguousAliases.has(alias.toLowerCase())) return true;
    // 歧义简称须与公司、证券或产品语境直接相邻，不能借用另一家公司的上下文。
    const name = /^[\x00-\x7f]+$/.test(alias) ? `(?<![A-Za-z0-9_])${escaped(alias)}(?![A-Za-z0-9_])` : escaped(alias);
    const company = '(?:公司|集团|控股|股份|股价|股票|财报|季报|年报|营收|净利润|市值|资本开支|手机|汽车|iPhone|MacBook)';
    return new RegExp(`${name}\\s*(?:的\\s*)?${company}`, 'i').test(text) ||
      new RegExp(`(?:美股|港股|科技公司)\\s*${name}`, 'i').test(text) ||
      new RegExp(`${name}\\s*[（(]\\s*${escaped(stock.symbol)}\\s*[）)]`, 'i').test(text);
  });
}
export function opinionStocks(opinion: Opinion): MarketStock[] {
  const body = `${opinion.title}\n${opinion.summary}\n${opinion.keyPoints.join('\n')}`;
  return stocks.filter(stock => mentionsCompany(body, stock) || new RegExp(`\\$${escaped(stock.symbol)}\\b`, 'i').test(body))
    .sort((a, b) => Number(mentionsCompany(opinion.title, b)) - Number(mentionsCompany(opinion.title, a))).slice(0, 4)
    .map(({ aliases: _aliases, ...stock }) => stock);
}
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const positive = (v: unknown): number | null => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
const finite = (v: unknown): number | null => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;
export function parseMarketQuote(text: string, stock: MarketStock, at: number): StockPerformance & { historyKey: string } {
  const match = text.match(new RegExp(`(?:^|[;\\s])v_${escaped(stock.key)}="([^"\\r\\n]*)"`));
  const fields = match?.[1]?.split('~') ?? [];
  const price = positive(fields[3]);
  const returnedSymbol = fields[2]?.replace(/\.(?:OQ|N|A|PK)$/i, '');
  const wantedSymbol = stock.market === 'HK' ? stock.symbol.replace(/^0+/, '') : stock.symbol;
  const actualSymbol = stock.market === 'HK' ? returnedSymbol?.replace(/^0+/, '') : returnedSymbol;
  if (!price || !fields[1] || actualSymbol?.toUpperCase() !== wantedSymbol.toUpperCase()) throw new Error('行情主体或价格无效');
  const quoteTime = fields[30]?.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3 $4:$5:$6').replaceAll('/', '-');
  if (!quoteTime || !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(quoteTime) || !validDate(quoteTime.slice(0, 10))) throw new Error('行情时间缺失');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: stock.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  if (quoteTime.slice(0, 10) > today) throw new Error('行情时间晚于当前交易所日期');
  const dayPct = finite(fields[32]);
  return { ...stock, status: 'ok', price, dayPct, fiveDayPct: null, twentyDayPct: null, quoteTime,
    fetchedAt: new Date(at).toISOString(), source: '腾讯财经', sourceUrl: `https://gu.qq.com/${stock.key}`,
    adjustment: null, note: null, historyKey: stock.market === 'US' ? `us${fields[2]}` : stock.key };
}
export function addHistory(quote: StockPerformance, raw: unknown, key: string): StockPerformance {
  const data = (raw as { data?: Record<string, { qfqday?: unknown[][]; day?: unknown[][] }> })?.data?.[key];
  const adjusted = Array.isArray(data?.qfqday);
  const rows = adjusted ? data!.qfqday! : data?.day;
  if (!Array.isArray(rows) || !rows.length) return { ...quote, note: '暂未获取区间日线' };
  let previousDate = '';
  const points: Array<{ date: string; close: number }> = [];
  for (const row of rows) {
    const date = row[0]; const close = positive(row[2]);
    if (typeof date !== 'string' || !validDate(date) || date <= previousDate || close === null) return { ...quote, note: '区间日线校验未通过' };
    previousDate = date; points.push({ date, close });
  }
  if (points.at(-1)!.date !== quote.quoteTime?.slice(0, 10)) return { ...quote, note: '区间日线尚未更新至行情交易日' };
  const change = (count: number) => {
    if (points.length <= count) return null;
    const value = (quote.price! / points[points.length - 1 - count]!.close - 1) * 100;
    return Number.isFinite(value) ? value : null;
  };
  return { ...quote, fiveDayPct: change(5), twentyDayPct: change(20), adjustment: adjusted ? '前复权' : '未复权',
    note: points.length <= 20 ? '上市或日线记录不足，部分区间暂无数据' : null };
}
const cacheRoot = fileURLToPath(new URL('../../../.local/dingtalk-market/', import.meta.url));
export class DingTalkMarketData {
  private memory = new Map<string, StockPerformance>();
  private pending = new Map<string, Promise<StockPerformance>>();
  private active = 0;
  private waiting: Array<() => void> = [];
  private directory: string;
  private transport: typeof fetch;
  private clock: () => number;
  constructor(directory = cacheRoot, transport: typeof fetch = fetch, clock = Date.now) {
    this.directory = directory; this.transport = transport; this.clock = clock;
  }
  private async request(url: string, stock: MarketStock, kind: string): Promise<Uint8Array> {
    const response = await this.transport(url, { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' } });
    if (!response.ok) throw new Error('行情请求失败');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 2_000_000) throw new Error('行情响应长度无效');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const dir = path.join(this.directory, 'raw'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const raw = path.join(dir, `${stock.key}-${kind}-${hash}.json`);
    try { fs.writeFileSync(raw, bytes, { mode: 0o600, flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return bytes;
  }
  private async load(stock: MarketStock, old?: StockPerformance): Promise<StockPerformance> {
    if (this.active >= 6) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.active++;
    try {
      const at = this.clock();
      let quote: StockPerformance;
      try {
        const text = new TextDecoder('gb18030').decode(await this.request(`https://qt.gtimg.cn/q=${stock.key}`, stock, 'quote'));
        const { historyKey, ...parsed } = parseMarketQuote(text, stock, at); quote = parsed;
        try {
          const endpoint = stock.market === 'US' ? 'usfqkline' : 'fqkline';
          const raw = await this.request(`https://web.ifzq.gtimg.cn/appstock/app/${endpoint}/get?param=${historyKey},day,,,60,qfq`, stock, 'history');
          quote = addHistory(quote, JSON.parse(new TextDecoder().decode(raw)), historyKey);
        } catch { quote.note = '暂未获取区间日线，最新价仍可参考'; }
      } catch {
        quote = old?.price ? { ...old, status: 'stale', note: '本次更新失败，显示上次成功获取的行情' }
          : { ...stock, status: 'unavailable', price: null, dayPct: null, fiveDayPct: null, twentyDayPct: null, quoteTime: null,
            fetchedAt: new Date(at).toISOString(), source: '腾讯财经', sourceUrl: `https://gu.qq.com/${stock.key}`, adjustment: null, note: '暂未获取最新行情' };
      }
      this.memory.set(stock.key, quote);
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, `${stock.key}.json`); const temp = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ checkedAt: at, quote }) + '\n', { mode: 0o600 }); fs.renameSync(temp, file);
      this.checked.set(stock.key, at);
      return quote;
    } finally { this.active--; this.waiting.shift()?.(); }
  }
  private checked = new Map<string, number>();
  get(stock: MarketStock): Promise<StockPerformance> {
    if (!this.memory.has(stock.key)) {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(this.directory, `${stock.key}.json`), 'utf8'));
        const q = saved.quote;
        const optionalNumber = (v: unknown) => v === null || typeof v === 'number' && Number.isFinite(v);
        if (q?.key === stock.key && ['ok', 'stale', 'unavailable'].includes(q.status) &&
            (q.status === 'unavailable' ? q.price === null : typeof q.price === 'number' && Number.isFinite(q.price) && q.price > 0) &&
            [q.dayPct, q.fiveDayPct, q.twentyDayPct].every(optionalNumber) &&
            (q.quoteTime === null || typeof q.quoteTime === 'string' && validDate(q.quoteTime.slice(0, 10))) &&
            (q.status === 'unavailable' || typeof q.quoteTime === 'string') &&
            [null, '前复权', '未复权'].includes(q.adjustment) && (q.note === null || typeof q.note === 'string') &&
            typeof saved.checkedAt === 'number' && Number.isFinite(saved.checkedAt) && typeof q.fetchedAt === 'string' && Number.isFinite(Date.parse(q.fetchedAt))) {
          this.memory.set(stock.key, { ...stock, status: q.status, price: q.price, dayPct: q.dayPct, fiveDayPct: q.fiveDayPct, twentyDayPct: q.twentyDayPct,
            quoteTime: q.quoteTime, fetchedAt: q.fetchedAt, source: '腾讯财经', sourceUrl: `https://gu.qq.com/${stock.key}`, adjustment: q.adjustment, note: q.note });
          this.checked.set(stock.key, saved.checkedAt);
        }
      } catch { /* 首次取数或无效缓存重新获取。 */ }
    }
    const old = this.memory.get(stock.key);
    const age = this.clock() - (this.checked.get(stock.key) ?? 0);
    if (old && age >= 0 && age < (old.status === 'ok' ? 300000 : 60000)) return Promise.resolve(old);
    let promise = this.pending.get(stock.key);
    if (!promise) {
      promise = this.load(stock, old).finally(() => this.pending.delete(stock.key)); this.pending.set(stock.key, promise);
    }
    return promise;
  }
}
const market = new DingTalkMarketData();
export async function buildDingTalkMarketFeed(opinions: Opinion[], provider = market): Promise<DingTalkMarketFeed> {
  const byOpinionId: Record<string, string[]> = {};
  const unique = new Map<string, MarketStock>();
  for (const opinion of opinions) {
    const selected = opinionStocks(opinion);
    if (selected.length) byOpinionId[opinion.id] = selected.map(stock => { unique.set(stock.key, stock); return stock.key; });
  }
  const quotes = Object.fromEntries(await Promise.all([...unique].map(async ([key, stock]) => [key, await provider.get(stock)])));
  return { byOpinionId, quotes };
}
