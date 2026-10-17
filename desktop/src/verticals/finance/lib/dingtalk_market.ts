export interface DingTalkStockPerformance {
  key: string; symbol: string; name: string; market: 'US' | 'CN' | 'HK'; currency: 'USD' | 'CNY' | 'HKD'; timezone: string;
  status: 'ok' | 'stale' | 'unavailable'; price: number | null; dayPct: number | null;
  fiveDayPct: number | null; twentyDayPct: number | null; quoteTime: string | null;
  fetchedAt: string; source: string; sourceUrl: string; adjustment: string | null; note: string | null;
}
export interface DingTalkMarketFeed { byOpinionId: Record<string, string[]>; quotes: Record<string, DingTalkStockPerformance> }
