/** Nova 推送的简放公开微博；线上只读本地快照。 */
import fs from 'node:fs';

export class WeiboSnapshotError extends Error {
  readonly status: number;
  constructor(message: string, status = 503) { super(message); this.status = status; }
}
export interface WeiboPost {
  id: string; author: string; time: string; text: string; textComplete: boolean; url: string; images: string[];
  source: string; likes: number; comments: number; reposts: number; pinned: boolean; repost: WeiboPost | null;
}
const text = (v: unknown): v is string => typeof v === 'string' && Boolean(v.trim());
const time = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v));
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const exact = (obj: Record<string, unknown>, keys: string[]) => Object.keys(obj).sort().join(',') === [...keys].sort().join(',');
function validatePost(value: unknown, nested = false): WeiboPost {
  const invalid = () => { throw new WeiboSnapshotError('微博快照内容格式无效'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const p = value as Record<string, unknown>;
  if (!exact(p, ['id', 'author', 'time', 'text', 'textComplete', 'url', 'images', 'source', 'likes', 'comments', 'reposts', 'pinned', 'repost']) ||
      !text(p.id) || !/^\d+$/.test(p.id) || !text(p.author) || !time(p.time) || typeof p.text !== 'string' || typeof p.source !== 'string' ||
      typeof p.textComplete !== 'boolean' || typeof p.pinned !== 'boolean' || !integer(p.likes) || !integer(p.comments) || !integer(p.reposts) ||
      !text(p.url) || !/^https:\/\/weibo\.com\/\d+\/[a-zA-Z0-9]+$/.test(p.url) || (!nested && !p.url.startsWith('https://weibo.com/1357064103/')) ||
      !Array.isArray(p.images) || !p.images.every(v => {
        if (!text(v)) return false;
        if (/^\/vibe-research\/semi-assets\/weibo\/[a-f0-9]{64}\.(?:jpg|png|webp|gif)$/.test(v)) return true;
        try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && /(^|\.)sinaimg\.cn$/.test(u.hostname); }
        catch { return false; }
      }) || (!p.text.trim() && !p.images.length) || (nested && p.repost !== null)) invalid();
  return { ...p, repost: p.repost === null ? null : validatePost(p.repost, true) } as unknown as WeiboPost;
}
export function fetchJianfang(query = new URLSearchParams()) {
  const file = process.env.JIANFANG_SNAPSHOT_FILE?.trim() || '/opt/vibe-research/shared/weibo/jianfang.json';
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new WeiboSnapshotError('尚未收到简放微博内容，请稍后刷新'); }
  const invalid = () => { throw new WeiboSnapshotError('简放微博快照格式无效'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  const d = raw as Record<string, unknown>;
  if (!exact(d, ['schemaVersion', 'uid', 'label', 'author', 'profileUrl', 'syncedAt', 'lastAttemptAt', 'status', 'error', 'items']) ||
      d.schemaVersion !== 1 || d.uid !== '1357064103' || d.label !== '简放' || d.author !== '交易者简放' ||
      d.profileUrl !== 'https://www.weibo.com/u/1357064103' || !time(d.syncedAt) || !time(d.lastAttemptAt) ||
      !['ok', 'partial', 'error'].includes(d.status as string) || (d.error !== null && !text(d.error)) ||
      (d.status === 'ok' && d.error !== null) || (d.status !== 'ok' && !text(d.error)) || !Array.isArray(d.items)) invalid();
  const items = (d.items as unknown[]).map(p => validatePost(p)).sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || b.id.localeCompare(a.id));
  if (new Set(items.map(p => p.id)).size !== items.length) invalid();
  const bounded = (v: string | null, fallback: number, max: number) => {
    const n = v === null ? fallback : Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.trunc(n))) : fallback;
  };
  const limit = Math.max(1, bounded(query.get('limit'), 30, 100));
  const offset = bounded(query.get('offset'), 0, items.length);
  const q = (query.get('q') || '').trim().toLocaleLowerCase('zh-CN');
  if (q.length > 200) throw new WeiboSnapshotError('检索词请控制在 200 字以内', 400);
  const filtered = items.filter(p => !q || `${p.text}\n${p.repost?.text || ''}`.toLocaleLowerCase('zh-CN').includes(q));
  return { schemaVersion: 1 as const, uid: d.uid as string, label: d.label as string, author: d.author as string, profileUrl: d.profileUrl as string,
    syncedAt: d.syncedAt as string, lastAttemptAt: d.lastAttemptAt as string, status: d.status as 'ok' | 'partial' | 'error', error: d.error as string | null,
    total: items.length, filteredTotal: filtered.length, offset, limit, hasMore: offset + limit < filtered.length, items: filtered.slice(offset, offset + limit) };
}
