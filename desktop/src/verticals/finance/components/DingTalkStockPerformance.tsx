import type { DingTalkStockPerformance } from '../lib/dingtalk_market';
const pct = (value: number | null) => value === null || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
const tone = (value: number | null) => value === null || value === 0 ? 'text-foreground' : value > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400';
const units = { USD: '美元', CNY: '元', HKD: '港元' };
const markets = { US: '美股', CN: 'A股', HK: '港股' };
const clocks = { US: '纽约时间', CN: '北京时间', HK: '香港时间' };
export function DingTalkStockPerformance({ quotes }: { quotes: DingTalkStockPerformance[] }) {
  if (!quotes.length) return null;
  return <section aria-label="股价表现" className="mt-3 space-y-3 rounded-lg border border-border/70 bg-muted/30 p-3">
    <h4 className="text-xs font-semibold">股价表现</h4>
    {quotes.map(quote => <div key={quote.key} className="min-w-0 border-t border-border/50 pt-2 first-of-type:border-0 first-of-type:pt-0">
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
