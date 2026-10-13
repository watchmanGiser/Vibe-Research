/** 原文快照：完整正文、全文检索与整页列表。 */
import fs from 'node:fs';
import { DingTalkSnapshotError } from './dingtalk_semi.ts';

export interface DingTalkMessage {
  id: string; time: string; sender: string; text: string; duplicateCount: number;
  relatedIds: string[]; latestDuplicateTime: string | null;
  images?: Array<{ reference: string; url: string }>;
  versions?: Array<{ id: string; time: string; sender: string; text: string; images?: Array<{ reference: string; url: string }> }>;
}
const exact = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).sort().join(',') === [...keys].sort().join(',');
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const timestamp = (s: string) => Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + '+08:00' : s);
const time = (v: unknown): v is string => text(v) && Number.isFinite(timestamp(v));
const integer = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

export function fetchDingTalkMessages(query = new URLSearchParams()) {
  const file = process.env.DINGTALK_RAW_SNAPSHOT_FILE?.trim() || '/opt/vibe-research/shared/semi/dingtalk-raw.json';
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new DingTalkSnapshotError('原始消息暂不可用，请稍后刷新'); }
  const invalid = () => { throw new DingTalkSnapshotError('原始消息快照格式无效'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !exact(raw as Record<string, unknown>, ['schemaVersion', 'label', 'syncedAt', 'duplicateCount', 'messages'])) invalid();
  const data = raw as Record<string, unknown>;
  if (data.schemaVersion !== 1 || data.label !== '击球区原始消息' || !time(data.syncedAt) || !integer(data.duplicateCount) || !Array.isArray(data.messages)) invalid();
  const messages = (data.messages as unknown[]).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !exact(item as Record<string, unknown>, ['id', 'time', 'sender', 'text', 'duplicateCount', 'relatedIds', 'latestDuplicateTime', ...(Object.hasOwn(item, 'images') ? ['images'] : []), ...(Object.hasOwn(item, 'versions') ? ['versions'] : [])])) invalid();
    const m = item as Record<string, unknown>;
    if (!id(m.id) || !time(m.time) || !text(m.sender) || !text(m.text) || !integer(m.duplicateCount) ||
        !Array.isArray(m.relatedIds) || !m.relatedIds.every(id) || !m.relatedIds.includes(m.id) ||
        (m.latestDuplicateTime !== null && !time(m.latestDuplicateTime))) invalid();
    const references = new Set([...(m.text as string).matchAll(/\[图片消息\]\(mediaId=([^\r\n)]+)\)/g)].map(match => match[1]!.trim()));
    if (m.images !== undefined && (!Array.isArray(m.images) || !m.images.every(image => image && typeof image === 'object' && !Array.isArray(image) &&
        exact(image, ['reference', 'url']) && text(image.reference) && references.has(image.reference) &&
        typeof image.url === 'string' && /^\/dingtalk\/media\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/.test(image.url)))) invalid();
    if (m.versions !== undefined && (!Array.isArray(m.versions) || !m.versions.every(version => {
      if (!version || typeof version !== 'object' || Array.isArray(version) || !exact(version, ['id', 'time', 'sender', 'text', ...(Object.hasOwn(version, 'images') ? ['images'] : [])]) ||
          !id(version.id) || !(m.relatedIds as string[]).includes(version.id) || !time(version.time) || !text(version.sender) || !text(version.text)) return false;
      const versionRefs = new Set([...version.text.matchAll(/\[图片消息\]\(mediaId=([^\r\n)]+)\)/g)].map(match => match[1]!.trim()));
      return version.images === undefined || Array.isArray(version.images) && version.images.every((image: Record<string, unknown>) => image && typeof image === 'object' && !Array.isArray(image) &&
        exact(image, ['reference', 'url']) && text(image.reference) && versionRefs.has(image.reference) && typeof image.url === 'string' && /^\/dingtalk\/media\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/.test(image.url));
    }))) invalid();
    return m as unknown as DingTalkMessage;
  }).sort((a, b) => timestamp(b.time) - timestamp(a.time) || a.id.localeCompare(b.id));
  const requestedLimit = Number(query.get('limit') ?? 30);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.trunc(requestedLimit))) : 30;
  const requestedOffset = Number(query.get('offset') ?? 0);
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.trunc(requestedOffset)) : 0;
  const keyword = (query.get('q') || '').trim().toLocaleLowerCase('zh-CN');
  const selectedId = query.get('id') || '';
  const filtered = messages.filter(m => (!keyword || `${m.sender}\n${m.text}\n${(m.versions || []).map(v => `${v.sender}\n${v.text}`).join('\n')}`.toLocaleLowerCase('zh-CN').includes(keyword)) && (!selectedId || m.relatedIds.includes(selectedId)));
  return { schemaVersion: 1, label: data.label as string, syncedAt: data.syncedAt as string,
    duplicateCount: data.duplicateCount as number, total: messages.length, filteredTotal: filtered.length,
    offset: query.get('all') === '1' ? 0 : offset, limit: query.get('all') === '1' ? filtered.length : limit,
    hasMore: query.get('all') !== '1' && offset + limit < filtered.length,
    messages: query.get('all') === '1' ? filtered : filtered.slice(offset, offset + limit) };
}
