import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
interface SemiTweet {
  id: string; handle?: string; author_name?: string; author_screen?: string;
  created_ts?: number; text?: string; zh?: string; take?: string; category?: string;
  url?: string; author_avatar?: string; media?: string | string[];
  likes?: number; retweets?: number; replies?: number; translated?: number;
}
interface SemiFeed {
  source: string; count: number; total: number; translated: number; pushed_at?: string; transport?: string; items: SemiTweet[];
}
interface SemiStatus {
  running: boolean; mode: string; last_error?: string; source_cooldown_remaining?: number;
  counts?: { total?: number; translated?: number }; pushed_at?: string; transport?: string;
}

function formatSemiTime(ts?: number): string {
  if (!ts) return "时间待确认";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts * 1000));
}

function semiMediaList(value?: string | string[]): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    // 兼容旧快照中的单个图片地址。
  }
  return value.startsWith(("http")) || value.startsWith("/") ? [value] : [];
}

export function SemiPanel() {
  const [data, setData] = useState<SemiFeed | null>(null);
  const [status, setStatus] = useState<SemiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const [tweets, state] = await Promise.all([api.semiTweets(200), api.semiStatus()]);
      setData(tweets); setStatus(state);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const pushed = data?.pushed_at ? new Date(data.pushed_at).toLocaleString("zh-CN", { hour12: false }) : "尚未推送";
  const cooldown = Math.max(0, status?.source_cooldown_remaining ?? 0);
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>nova 主动推送 · 最近同步 {pushed}</span>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">累计 {data?.total ?? status?.counts?.total ?? 0} 条</span>
        <span className="rounded-full bg-muted px-2 py-0.5">已翻译 {data?.translated ?? status?.counts?.translated ?? 0} 条</span>
        {status?.running && <span className="inline-flex items-center gap-1 text-primary"><Loader2 className="h-3 w-3 animate-spin" /> 抓取中</span>}
        {cooldown > 0 && <span className="text-warning">数据源冷却约 {Math.ceil(cooldown / 3600)} 小时</span>}
        <button onClick={() => void load()} disabled={loading} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 hover:text-primary disabled:opacity-50">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> 刷新展示
        </button>
      </div>
      {status?.last_error && <div className="mb-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning">最近抓取异常：{status.last_error}</div>}
      {err ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{err}</div>
      ) : loading && !data ? (
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> 正在读取 nova 推送结果…</p>
      ) : !data?.items.length ? (
        <div className="rounded-lg border border-dashed border-border/70 p-10 text-center">
          <p className="text-sm font-medium">暂时还没有 Semi 抓取结果</p>
          <p className="mt-2 text-xs text-muted-foreground">推送链路正常；nova 抓取到新内容后，最长约 5 分钟会显示在这里。</p>
        </div>
      ) : (
        <div className="divide-y divide-border/40">
          {data.items.map((item) => {
            const author = item.author_name || item.author_screen || item.handle || "Semi";
            const main = item.zh || item.text || "";
            const showOriginal = Boolean(item.zh && item.text && item.zh !== item.text);
            const images = semiMediaList(item.media);
            return (
              <a key={item.id} href={item.url || undefined} target={item.url ? "_blank" : undefined} rel="noreferrer" className="group block py-3 first:pt-0 last:pb-0">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {item.author_avatar && <img src={item.author_avatar} alt="" loading="lazy" decoding="async" className="h-7 w-7 rounded-full border border-border/60 object-cover" onError={(event) => { event.currentTarget.style.display = "none"; }} />}
                  <span className="font-medium text-primary">{author}</span>
                  {item.author_screen && <span>@{item.author_screen}</span>}
                  <span>{formatSemiTime(item.created_ts)}</span>
                  {item.category && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">{item.category}</span>}
                  <span className="ml-auto">赞 {item.likes ?? 0} · 转 {item.retweets ?? 0} · 评 {item.replies ?? 0}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6 group-hover:text-primary">{main}</p>
                {showOriginal && <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground/70">原文：{item.text}</p>}
                {images.length > 0 && <div className={cn("mt-2 grid gap-2 overflow-hidden rounded-xl", images.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
                  {images.slice(0, 4).map((src, index) => <img key={`${item.id}-${index}`} src={src} alt={`${author} 动态配图 ${index + 1}`} loading="lazy" decoding="async" className="max-h-96 w-full rounded-xl border border-border/50 bg-muted/20 object-contain" onError={(event) => { event.currentTarget.style.display = "none"; }} />)}
                </div>}
                {item.take && <div className="mt-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-xs leading-5 text-muted-foreground"><b className="text-primary">解读：</b>{item.take}</div>}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function DingTalkGroupPanel() {
  type Opinion = { id: string; time: string; title: string; summary: string; keyPoints: string[]; caveats: string[] };
  type Feed = { schemaVersion: 2; label: string; syncedAt: string; duplicateCount: number; opinions: Opinion[] };
  const [data, setData] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try { setData(await api.dingtalkGroup(200)); }
    catch (error) { setErr(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const synced = data?.syncedAt ? new Date(data.syncedAt).toLocaleString("zh-CN", { hour12: false }) : "尚未整理";
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>击球区观点 · Nova 本地 GPT 整理</span><span>最近整理 {synced}</span>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">当前 {data?.opinions.length ?? 0} 篇</span>
        <span className="rounded-full bg-muted px-2 py-0.5">合并重复 {data?.duplicateCount ?? 0} 条</span>
        <button onClick={() => void load()} disabled={loading} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 hover:text-primary disabled:opacity-50"><RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> 刷新展示</button>
      </div>
      {err ? <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm text-warning">{err}<p className="mt-1 text-xs">摘要暂不可用；不能据此判断没有新观点。</p></div>
      : loading && !data ? <p className="py-10 text-sm text-muted-foreground">正在读取观点摘要…</p>
      : !data?.opinions.length ? <div className="rounded-lg border border-dashed border-border/70 p-10 text-center text-sm">暂无已整理的长篇观点。</div>
      : <div className="divide-y divide-border/40">{data.opinions.map(item => <article key={item.id} className="py-4 first:pt-0 last:pb-0">
          <div className="mb-2 text-xs text-muted-foreground">资料时间 {item.time} · 第三方观点，待独立核验</div>
          <h3 className="mb-2 text-base font-semibold">{item.title}</h3>
          <p className="mb-2 whitespace-pre-wrap break-words text-sm leading-6">{item.summary}</p>
          <ul className="list-disc pl-5 text-sm leading-6">{item.keyPoints.map((point, i) => <li key={i}>{point}</li>)}</ul>
          {item.caveats.length > 0 && <div className="mt-2 text-xs text-warning">风险 / 待核验：{item.caveats.join("；")}</div>}
        </article>)}</div>}
    </div>
  );
}

