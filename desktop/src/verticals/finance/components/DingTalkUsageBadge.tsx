import { useEffect, useState } from 'react';

export interface DingTalkUsage {
  schemaVersion: 1; date: string; limit: number; used: number; remaining: number;
  latestAt: string | null; latestStatus: 'running' | 'success' | 'timeout' | 'failed' | null; updatedAt: string;
}
const statuses = { running: '处理中', success: '成功', timeout: '超时', failed: '失败' };
const time = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const day = (now: number) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);

export function parseDingTalkUsage(value: unknown): DingTalkUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('调用统计格式无效');
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1 || typeof v.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.date) ||
    !Number.isSafeInteger(v.limit) || (v.limit as number) < 1 || !Number.isSafeInteger(v.used) || (v.used as number) < 0 ||
    !Number.isSafeInteger(v.remaining) || v.remaining !== Math.max(0, (v.limit as number) - (v.used as number)) ||
    !(v.latestAt === null || typeof v.latestAt === 'string' && Number.isFinite(Date.parse(v.latestAt))) ||
    !(v.latestStatus === null || typeof v.latestStatus === 'string' && Object.hasOwn(statuses, v.latestStatus)) ||
    (v.latestAt === null) !== (v.latestStatus === null) || typeof v.updatedAt !== 'string' || !Number.isFinite(Date.parse(v.updatedAt))) throw Error('调用统计格式无效');
  return value as DingTalkUsage;
}

export function DingTalkUsageView({ usage, unavailable = false, now = Date.now() }: { usage: DingTalkUsage | null; unavailable?: boolean; now?: number }) {
  const current = usage?.date === day(now);
  return <div className="ml-auto max-w-full text-right text-[11px] leading-5 text-muted-foreground" aria-label="GPT调用情况"
    title={usage ? `北京时间统计；更新于 ${new Date(usage.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}。失败和超时也计入已用次数。` : '从真实调用账本读取'}>
    <div className="flex flex-wrap justify-end gap-x-2"><span>本地 GPT 整理</span>
      {usage?.latestAt && <span>最新 {time(usage.latestAt)} · {statuses[usage.latestStatus!]}</span>}</div>
    <div className="flex flex-wrap justify-end gap-x-3">
      {unavailable ? <span>调用统计暂不可用</span> : !usage ? <span>正在读取调用情况…</span> : !current ? <span>今日调用情况待同步</span> : <>
        <span>今日已用 <strong className="font-medium text-foreground">{usage.used}</strong> / {usage.limit} 次</span>
        <span>还剩 <strong className="font-medium text-foreground">{usage.remaining}</strong> 次</span>
      </>}
    </div>
  </div>;
}

export function DingTalkUsageBadge({ refreshVersion = 0 }: { refreshVersion?: number }) {
  const [usage, setUsage] = useState<DingTalkUsage | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true; let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort(); controller = new AbortController();
      try {
        const response = await fetch('/dingtalk/usage.json', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        if (!response.ok) throw Error('调用统计不可用');
        const result = parseDingTalkUsage(await response.json());
        if (active) { setUsage(result); setUnavailable(false); }
      } catch (error) { if (active && !(error instanceof Error && error.name === 'AbortError')) setUnavailable(true); }
    };
    void load(); const timer = window.setInterval(() => { void load(); }, 60000);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); };
  }, [refreshVersion]);
  return <DingTalkUsageView usage={usage} unavailable={unavailable} />;
}
