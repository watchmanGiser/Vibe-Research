import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, FileText, Lightbulb, Loader2, RefreshCw, Search } from "lucide-react";
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

type DingTalkOpinionFeed = Awaited<ReturnType<typeof api.dingtalkGroup>>;
type DingTalkMessageFeed = Awaited<ReturnType<typeof api.dingtalkMessages>>;
type DingTalkMessage = DingTalkMessageFeed["messages"][number];

function formatDingTalkTime(value: string): string {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(" ", "T") + "+08:00" : value;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : value;
}

export function DingTalkMessageCard({ item, defaultExpanded = false }: { item: DingTalkMessage; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const long = item.text.length > 600;
  return (
    <article className="rounded-xl border border-border/60 bg-background/40 p-4" data-message-id={item.id}>
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-primary">{item.sender}</span>
        <time>{formatDingTalkTime(item.time)}</time>
        {item.duplicateCount > 0 && <span className="rounded-full bg-muted px-2 py-0.5" title={item.latestDuplicateTime ? `最近重复：${formatDingTalkTime(item.latestDuplicateTime)}` : undefined}>已合并 {item.duplicateCount} 条重复</span>}
      </div>
      <p className={cn("whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]", long && !expanded && "line-clamp-6")}>{item.text}</p>
      {long && <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}
        className="mt-3 rounded-md px-1 py-1 text-xs font-medium text-primary hover:bg-primary/10">{expanded ? "收起全文" : `展开全文（${item.text.length.toLocaleString("zh-CN")} 字）`}</button>}
    </article>
  );
}

export function DingTalkGroupPanel() {
  const [data, setData] = useState<DingTalkOpinionFeed | null>(null);
  const [messages, setMessages] = useState<DingTalkMessageFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [messageLoading, setMessageLoading] = useState(true);
  const [err, setErr] = useState("");
  const [messageErr, setMessageErr] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [offset, setOffset] = useState(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const pageSize = 30;

  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search.trim()); setOffset(0); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    setLoading(true); setErr("");
    void api.dingtalkGroup(500).then(value => { if (active) setData(value); })
      .catch(error => { if (active) setErr(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refreshVersion]);

  useEffect(() => {
    let active = true;
    setMessageLoading(true); setMessageErr("");
    void api.dingtalkMessages({ limit: pageSize, offset, q: query, id: selectedId }).then(value => {
      if (active) setMessages(value);
    }).catch(error => {
      if (active) { setMessages(null); setMessageErr(error instanceof Error ? error.message : String(error)); }
    }).finally(() => { if (active) setMessageLoading(false); });
    return () => { active = false; };
  }, [offset, query, selectedId, refreshVersion]);

  const synced = messages?.syncedAt ? formatDingTalkTime(messages.syncedAt) : "尚未同步";
  const summaryTime = data?.syncedAt ? formatDingTalkTime(data.syncedAt) : "尚未整理";
  const page = Math.floor(offset / pageSize) + 1;
  const pages = Math.max(1, Math.ceil((messages?.filteredTotal ?? 0) / pageSize));
  const showOriginal = (id: string) => { setSearch(""); setQuery(""); setOffset(0); setSelectedId(id); };
  const clearFilters = () => { setSearch(""); setQuery(""); setOffset(0); setSelectedId(""); };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded-full bg-primary/10 px-3 py-1 text-primary">原始消息 {messages?.total ?? "—"} 条</span>
        <span className="rounded-full bg-muted px-3 py-1">已合并重复 {messages?.duplicateCount ?? data?.duplicateCount ?? "—"} 条</span>
        <span className="rounded-full bg-muted px-3 py-1">观点总结 {data?.opinions.length ?? "—"} 篇</span>
        <button type="button" onClick={() => setRefreshVersion(value => value + 1)} disabled={loading || messageLoading}
          className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 hover:text-primary disabled:opacity-50">
          <RefreshCw className={cn("h-3.5 w-3.5", (loading || messageLoading) && "animate-spin")} /> 刷新展示
        </button>
      </div>
      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <section aria-label="原始消息" className="flex min-w-0 flex-col rounded-xl border border-border/70 bg-background/20 lg:h-[calc(100dvh-370px)] lg:min-h-[420px]">
          <div className="border-b border-border/60 p-4">
            <div className="mb-1 flex items-center gap-2"><FileText className="h-4 w-4 text-primary" /><h3 className="font-semibold">原始消息</h3><span className="ml-auto text-[11px] text-muted-foreground">全文保留 · 去重展示</span></div>
            <p className="mb-3 text-[11px] text-muted-foreground">最近同步 {synced}</p>
            <form onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setOffset(0); }} className="flex items-center gap-2 rounded-lg border border-border bg-background/50 px-3 py-2">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input value={search} onChange={event => { setSearch(event.target.value); setSelectedId(""); }} aria-label="搜索原始消息" placeholder="搜索全部历史原文或发送者…"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60" />
              {(search || selectedId) && <button type="button" onClick={clearFilters} className="shrink-0 text-xs text-primary">清除</button>}
            </form>
            {selectedId && <div className="mt-2 flex items-center justify-between gap-2 text-xs"><span className="text-primary">正在查看总结对应的原文</span><button type="button" onClick={clearFilters} className="text-muted-foreground hover:text-primary">返回全部消息</button></div>}
            {query && !messageLoading && <p className="mt-2 text-xs text-muted-foreground">全文搜索结果：{messages?.filteredTotal ?? 0} 条</p>}
          </div>
          <div key={`${offset}:${query}:${selectedId}`} className="min-h-[300px] max-h-[65vh] flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 lg:min-h-0 lg:max-h-none" tabIndex={0} aria-label="原文列表">
            {messageErr ? <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm text-warning">{messageErr}</div>
            : messageLoading ? <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取完整原文…</p>
            : !messages?.messages.length ? <p className="py-10 text-center text-sm text-muted-foreground">{query || selectedId ? "没有匹配的原始消息。" : "暂无已同步的原始消息。"}</p>
            : messages.messages.map(item => <DingTalkMessageCard key={item.id} item={item} defaultExpanded={Boolean(selectedId)} />)}
          </div>
          <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
            <span>{query || selectedId ? `匹配 ${messages?.filteredTotal ?? 0} 条` : `共 ${messages?.total ?? 0} 条`} · 第 {page} / {pages} 页</span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setOffset(value => Math.max(0, value - pageSize))} disabled={offset === 0 || messageLoading}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 hover:text-primary disabled:opacity-40"><ChevronLeft className="h-3 w-3" />上一页</button>
              <button type="button" onClick={() => setOffset(value => value + pageSize)} disabled={!messages?.hasMore || messageLoading}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 hover:text-primary disabled:opacity-40">下一页<ChevronRight className="h-3 w-3" /></button>
            </div>
          </div>
        </section>
        <section aria-label="观点总结" className="flex min-w-0 flex-col rounded-xl border border-border/70 bg-background/20 lg:h-[calc(100dvh-370px)] lg:min-h-[420px]">
          <div className="border-b border-border/60 p-4">
            <div className="mb-1 flex items-center gap-2"><Lightbulb className="h-4 w-4 text-primary" /><h3 className="font-semibold">观点总结</h3><span className="ml-auto text-[11px] text-muted-foreground">Nova 本地 GPT 整理</span></div>
            <p className="text-[11px] text-muted-foreground">最近整理 {summaryTime}</p>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">保留现有主题、概述、主要观点与待核验风险。</p>
          </div>
          <div className="min-h-[300px] max-h-[65vh] flex-1 overflow-y-auto overscroll-contain p-4 lg:min-h-0 lg:max-h-none" tabIndex={0} aria-label="总结列表">
            {err && <div className="mb-3 rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm text-warning">{err}<p className="mt-1 text-xs">摘要暂不可用；不能据此判断没有新观点。</p></div>}
            {loading && !data ? <p className="py-10 text-sm text-muted-foreground">正在读取观点摘要…</p>
            : !data?.opinions.length && !err ? <p className="py-10 text-center text-sm text-muted-foreground">暂无已整理的长篇观点。</p>
            : <div className="divide-y divide-border/40">{data?.opinions.map(item => <article key={item.id} className="py-4 first:pt-0 last:pb-0">
                <div className="mb-2 text-[11px] text-muted-foreground">资料时间 {formatDingTalkTime(item.time)} · 第三方观点，待独立核验</div>
                <h3 className="mb-2 text-base font-semibold">{item.title}</h3>
                <p className="mb-2 whitespace-pre-wrap break-words text-sm leading-6">{item.summary}</p>
                <ul className="list-disc pl-5 text-sm leading-6">{item.keyPoints.map((point, i) => <li key={i}>{point}</li>)}</ul>
                {item.caveats.length > 0 && <div className="mt-2 text-xs text-warning">风险 / 待核验：{item.caveats.join("；")}</div>}
                <button type="button" onClick={() => showOriginal(item.id)} className="mt-3 inline-flex items-center gap-1 rounded-md border border-primary/20 px-2 py-1 text-xs text-primary hover:bg-primary/10"><FileText className="h-3 w-3" />查看对应原文</button>
              </article>)}</div>}
          </div>
          <div className="mt-auto border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">当前保留 {data?.opinions.length ?? 0} 篇总结 · 可点击总结查看对应原文</div>
        </section>
      </div>
    </div>
  );
}
