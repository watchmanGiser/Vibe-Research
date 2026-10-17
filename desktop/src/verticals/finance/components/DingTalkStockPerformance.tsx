import { Fragment } from 'react';
import type { DingTalkStockPerformance } from '../lib/dingtalk_market';
const pct = (value: number | null) => value === null || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
const tone = (value: number | null) => value === null || value === 0 ? 'text-foreground' : value > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400';
const units = { USD: '美元', CNY: '元', HKD: '港元' };
const markets = { US: '美股', CN: 'A股', HK: '港股' };
const clocks = { US: '纽约时间', CN: '北京时间', HK: '香港时间' };
function timeLabel(quote: DingTalkStockPerformance) {
  return `截至 ${quote.quoteTime || '时间待确认'}（${clocks[quote.market]}）`;
}
function MultipleStockRows({ quotes }: { quotes: DingTalkStockPerformance[] }) {
  const times = new Map<string, { quote: DingTalkStockPerformance; names: string[] }>();
  const available = quotes.filter(quote => quote.status !== 'unavailable');
  for (const quote of available) {
    const key = `${quote.market}|${quote.quoteTime ?? ''}`;
    const group = times.get(key);
    if (group) group.names.push(quote.name);
    else times.set(key, { quote, names: [quote.name] });
  }
  const qualifyTime = times.size > 1 || available.length !== quotes.length;
  return <>
    <div className="overflow-x-auto">
      <table aria-label="多只股票股价表现" className="w-full min-w-[280px] table-fixed text-[11px] tabular-nums">
        <colgroup><col style={{ width: '31%' }} /><col style={{ width: '24%' }} /><col span={3} style={{ width: '15%' }} /></colgroup>
        <thead className="text-[10px] text-muted-foreground">
          <tr>{['股票', '最新价', '当日', '近5日', '近20日'].map((label, index) => <th key={label} scope="col" className={`pb-2 font-normal ${index === 0 ? 'text-left' : 'text-right'}`}>{label}</th>)}</tr>
        </thead>
        <tbody>
          {quotes.map(quote => <Fragment key={quote.key}>
            <tr className="border-t border-border/50">
              <th scope="row" className="break-words py-2 pr-2 text-left align-top font-normal">
                <div className="font-medium">{quote.name}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">{quote.symbol} · {markets[quote.market]}</div>
                {quote.status === 'stale' && <div className="mt-0.5 text-[10px] text-warning">缓存行情</div>}
              </th>
              {quote.status === 'unavailable' ? <td colSpan={4} className="py-2 text-right align-top text-muted-foreground">{quote.note || '暂未获取最新行情'}</td> : <>
                <td className="py-2 text-right align-top"><div className="whitespace-nowrap font-semibold">{quote.price === null ? '—' : quote.price.toFixed(2)}</div><div className="mt-0.5 text-[10px] text-muted-foreground">{units[quote.currency]}</div></td>
                {[quote.dayPct, quote.fiveDayPct, quote.twentyDayPct].map((value, index) => <td key={index} className={`whitespace-nowrap py-2 text-right align-top font-semibold ${tone(value)}`}>{pct(value)}</td>)}
              </>}
            </tr>
            {quote.status !== 'unavailable' && quote.note && <tr><td colSpan={5} className={`pb-2 text-[10px] leading-4 ${quote.status === 'stale' ? 'text-warning' : 'text-muted-foreground'}`}>{quote.name}：{quote.note}</td></tr>}
          </Fragment>)}
        </tbody>
      </table>
    </div>
    {[...times].map(([key, group]) => <p key={key} className="mt-2 text-[10px] leading-5 text-muted-foreground">{qualifyTime ? `${group.names.join('、')}：` : ''}{timeLabel(group.quote)}</p>)}
  </>;
}
export function DingTalkStockPerformance({ quotes }: { quotes: DingTalkStockPerformance[] }) {
  if (!quotes.length) return null;
  return <section aria-label="股价表现" className="mt-3 space-y-3 rounded-lg border border-border/70 bg-muted/30 p-3">
    <h4 className="text-xs font-semibold">股价表现</h4>
    {quotes.length > 1 ? <MultipleStockRows quotes={quotes} /> : quotes.map(quote => <div key={quote.key} className="min-w-0 border-t border-border/50 pt-2 first-of-type:border-0 first-of-type:pt-0">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 text-xs font-medium">
        <span>{quote.name} · {quote.symbol}（{markets[quote.market]}）</span>
        {quote.status === 'stale' && <span className="text-warning">缓存行情</span>}
      </div>
      {quote.status === 'unavailable' ? <p className="text-xs text-muted-foreground">{quote.note || '暂未获取最新行情'}</p> : <>
        <dl className="grid grid-cols-4 gap-2 text-xs tabular-nums">
          <div><dt className="mb-1 text-[11px] text-muted-foreground">最新价</dt><dd className="font-semibold">{quote.price === null ? '—' : `${quote.price.toFixed(2)} ${units[quote.currency]}`}</dd></div>
          {[['当日', quote.dayPct], ['近5日', quote.fiveDayPct], ['近20日', quote.twentyDayPct]].map(([label, value]) => <div key={label as string}><dt className="mb-1 text-[11px] text-muted-foreground">{label}</dt><dd className={`font-semibold ${tone(value as number | null)}`}>{pct(value as number | null)}</dd></div>)}
        </dl>
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">截至 {quote.quoteTime || '时间待确认'}（{clocks[quote.market]}）</p>
        {quote.note && <p className={`mt-1 text-[11px] leading-5 ${quote.status === 'stale' ? 'text-warning' : 'text-muted-foreground'}`}>{quote.note}</p>}
      </>}
    </div>)}
  </section>;
}
