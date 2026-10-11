/** 线上仅读取 Nova 推送的结构化第三方观点摘要；旧原文格式一律拒绝。 */
import fs from 'node:fs';
export class DingTalkSnapshotError extends Error { readonly status = 503; }
const exact = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).sort().join(',') === keys.sort().join(',');
const text = (x: unknown, n: number) => typeof x === 'string' && x.trim().length > 0 && x.length <= n;
export function fetchDingTalkGroup(limit = 200) {
  const file = process.env.DINGTALK_SEMI_SNAPSHOT_FILE?.trim() || '/opt/vibe-research/shared/semi/dingtalk.json';
  let v: unknown;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new DingTalkSnapshotError('击球区观点摘要暂不可用'); }
  if (!v || typeof v !== 'object' || !exact(v as Record<string, unknown>, ['schemaVersion', 'label', 'syncedAt', 'duplicateCount', 'opinions'])) throw new DingTalkSnapshotError('观点摘要格式无效');
  const data = v as Record<string, unknown>;
  if (data.schemaVersion !== 2 || data.label !== '击球区观点' || !text(data.syncedAt, 60) || !Number.isFinite(Date.parse(data.syncedAt as string)) ||
      !Number.isInteger(data.duplicateCount) || (data.duplicateCount as number) < 0 || !Array.isArray(data.opinions)) throw new DingTalkSnapshotError('观点摘要格式无效');
  const opinions = data.opinions.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !exact(item as Record<string, unknown>, ['id', 'time', 'title', 'summary', 'keyPoints', 'caveats'])) throw new DingTalkSnapshotError('观点摘要格式无效');
    const m = item as Record<string, unknown>;
    if (typeof m.id !== 'string' || !/^[a-f0-9]{64}$/.test(m.id) || !text(m.time, 60) || !Number.isFinite(Date.parse(m.time as string)) ||
      !text(m.title, 100) || !text(m.summary, 800) || !Array.isArray(m.keyPoints) || m.keyPoints.length < 1 || m.keyPoints.length > 6 || !m.keyPoints.every((s) => text(s, 240)) ||
      !Array.isArray(m.caveats) || m.caveats.length > 5 || !m.caveats.every((s) => text(s, 240))) throw new DingTalkSnapshotError('观点摘要格式无效');
    return m as { id: string; time: string; title: string; summary: string; keyPoints: string[]; caveats: string[] };
  });
  return { schemaVersion: 2, label: '击球区观点', syncedAt: data.syncedAt as string, duplicateCount: data.duplicateCount as number,
    opinions: opinions.slice(0, Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 200) };
}
