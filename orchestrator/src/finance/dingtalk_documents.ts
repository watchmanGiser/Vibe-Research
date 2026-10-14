/** 公开文档元信息只接受本消息引用和本站缓存路径。 */
import { createHash } from 'node:crypto';

export interface DingTalkDocument {
  id: string; name: string; kind: 'pdf' | 'docx' | 'doc';
  status: 'pending' | 'ready' | 'partial' | 'download_failed' | 'parse_failed' | 'unsupported';
  url?: string; textUrl?: string; previewUrl?: string; pageCount?: number | null; previewImages?: string[]; unreadablePages?: number[];
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const pathPattern = /^\/dingtalk\/documents\/([a-f0-9]{64})(?:-[a-f0-9]{64})?(?:-preview|-page-\d{3})?\.(pdf|docx|doc|txt|jpg)$/;

export function validDingTalkDocuments(value: unknown, source: string): boolean {
  if (value === undefined) return true;
  const references = new Set([...source.matchAll(/https:\/\/[^\s<>\[\]]+/g)].map(match => hash(match[0].replace(/[)）。，；,;]+$/, ''))));
  if (!Array.isArray(value) || value.length > 100) return false;
  return value.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const d = item as Record<string, unknown>;
    const allowed = ['id', 'name', 'kind', 'status', 'url', 'textUrl', 'previewUrl', 'pageCount', 'previewImages', 'unreadablePages'];
    if (Object.keys(d).some(key => !allowed.includes(key)) || !['id', 'name', 'kind', 'status'].every(key => Object.hasOwn(d, key)) ||
      typeof d.id !== 'string' || !references.has(d.id) || typeof d.name !== 'string' || !d.name.trim() || d.name.length > 240 || /[\x00-\x1f\x7f/\\]/.test(d.name) ||
      typeof d.kind !== 'string' || !['pdf', 'docx', 'doc'].includes(d.kind) || typeof d.status !== 'string' || !['pending', 'ready', 'partial', 'download_failed', 'parse_failed', 'unsupported'].includes(d.status)) return false;
    const ownPath = (v: unknown, suffix: string) => typeof v === 'string' && pathPattern.test(v) && v.endsWith(suffix);
    if (d.url !== undefined && !ownPath(d.url, '.' + (d.kind as string))) return false;
    if (!['ready', 'partial'].includes(d.status as string)) return Object.keys(d).every(key => ['id', 'name', 'kind', 'status', 'url'].includes(key));
    if (!ownPath(d.url, '.' + (d.kind as string)) || !ownPath(d.textUrl, '.txt') ||
      (d.previewUrl !== undefined && !ownPath(d.previewUrl, '.pdf')) ||
      !(d.pageCount === null || Number.isSafeInteger(d.pageCount) && (d.pageCount as number) > 0 && (d.pageCount as number) <= 200) ||
      !Array.isArray(d.previewImages) || d.previewImages.length > 100 || !d.previewImages.every(url => ownPath(url, '.jpg'))) return false;
    if (d.status === 'partial' && (!Array.isArray(d.unreadablePages) || !d.unreadablePages.length || !d.unreadablePages.every(page => Number.isSafeInteger(page) && page > 0 && page <= (d.pageCount as number))) ||
      d.status === 'ready' && Object.hasOwn(d, 'unreadablePages')) return false;
    const fingerprint = (d.url as string).match(pathPattern)![1];
    return [d.textUrl, d.previewUrl, ...d.previewImages].filter(v => v !== undefined).every(v => (v as string).match(pathPattern)![1] === fingerprint);
  });
}
