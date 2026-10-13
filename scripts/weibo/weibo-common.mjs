/** 微博公共内容规范化；身份、时间和全文状态始终来自实际响应。 */
export const UID = '1357064103';
export const PROFILE_URL = `https://www.weibo.com/u/${UID}`;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function htmlToText(html = '') {
  return String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, '$1')
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div)>/gi, '\n')
    .replace(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, text) => /^https?:\/\/(?:m\.)?weibo\.(?:cn|com)\/(?:search|n|u|p)\b/i.test(url) ? text : `${text} (${url})`)
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
      if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? all;
      const n = parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }).replace(/[ \t]+\n/g, '\n').trim();
}
export function imageUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && /(^|\.)sinaimg\.cn$/.test(u.hostname) ? u.href : null; }
  catch { return null; }
}
export function normalizePost(raw, expanded = new Map(), isRepost = false) {
  if (!raw || !/^\d+$/.test(String(raw.id)) || (!isRepost && String(raw.user?.id) !== UID)) throw Error('微博账号或内容身份校验失败');
  const stamp = Date.parse(raw.created_at);
  if (!Number.isFinite(stamp)) throw Error('微博发布时间无效');
  const full = expanded.get(String(raw.id));
  const text = htmlToText(full?.longTextContent || raw.text || '');
  const images = [...new Set((raw.pics || []).map(p => imageUrl(p.large?.url || p.url)).filter(Boolean))];
  if (!text && !images.length) throw Error('微博内容为空，保留上次成功快照');
  const post = { id: String(raw.id), author: String(raw.user?.screen_name || '原微博作者'), time: new Date(stamp).toISOString(),
    text, textComplete: !raw.isLongText || Boolean(full?.longTextContent), url: `https://weibo.com/${raw.user?.id || UID}/${raw.bid || raw.id}`,
    images, source: htmlToText(raw.source), likes: Number(raw.attitudes_count) || 0,
    comments: Number(raw.comments_count) || 0, reposts: Number(raw.reposts_count) || 0,
    pinned: Boolean(raw.title?.text?.includes('置顶')), repost: null };
  if (!isRepost && raw.retweeted_status && !raw.retweeted_status.deleted) post.repost = normalizePost(raw.retweeted_status, expanded, true);
  return post;
}
export function mergePosts(previous, incoming) {
  const byId = new Map(previous.map(p => [p.id, p]));
  for (const post of incoming) {
    const old = byId.get(post.id);
    const next = { ...post };
    if (old?.textComplete && !post.textComplete) { next.text = old.text; next.textComplete = true; }
    if (old?.repost?.textComplete && next.repost && !next.repost.textComplete) next.repost = { ...next.repost, text: old.repost.text, textComplete: true };
    byId.set(post.id, next);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || b.id.localeCompare(a.id));
}
export function buildSnapshot(previous, incoming, at, warnings = []) {
  if (!Number.isFinite(Date.parse(at)) || !incoming.length) throw Error('同步结果为空或时间无效');
  const items = mergePosts(previous?.items || [], incoming);
  return { schemaVersion: 1, uid: UID, label: '简放', author: '交易者简放', profileUrl: PROFILE_URL,
    syncedAt: at, lastAttemptAt: at, status: warnings.length ? 'partial' : 'ok', error: warnings.length ? warnings.join('；') : null, items };
}
export function failureSnapshot(previous, at) {
  if (!previous || previous.uid !== UID || !Array.isArray(previous.items) || !previous.items.length) return null;
  return { ...previous, lastAttemptAt: at, status: 'error', error: '微博暂时未能同步，展示上次成功保存的内容' };
}
