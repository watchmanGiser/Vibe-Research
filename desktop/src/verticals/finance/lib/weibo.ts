/** 简放微博的展示契约。 */
export interface WeiboPost {
  id: string; author: string; time: string; text: string; textComplete: boolean; url: string; images: string[];
  source: string; likes: number; comments: number; reposts: number; pinned: boolean; repost: WeiboPost | null;
}
export interface JianfangFeed {
  schemaVersion: 1; uid: string; label: string; author: string; profileUrl: string;
  syncedAt: string; lastAttemptAt: string; status: 'ok' | 'partial' | 'error'; error: string | null;
  total: number; filteredTotal: number; offset: number; limit: number; hasMore: boolean; items: WeiboPost[];
}
export const weiboTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
