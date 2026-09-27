import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { TrendingUp, FileText, Newspaper, Rss, RefreshCw, Loader2, ExternalLink, AlertCircle, Sparkles, Lightbulb, Star, MessageSquareText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAiPage } from "../../../core/ai/pageContext";
import { useArchiveThenRefresh } from "../../../core/data/useArchiveThenRefresh";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { SaveNoteButton } from "@/components/ui/SaveNoteButton";
import { api, ApiError, type RadarData, type Industry, type Announcement, type NewsItem, type MacroProbability, type MacroProbItem } from "@/lib/api";
import { displayedHeadlineTranslation, hasChinese, headlineNeedsTranslation, loadHeadlineTranslationCache, saveHeadlineTranslationCache, splitHeadlineBatches } from "@/lib/headlineTranslation";
import { loadWatch } from "@/lib/watchlist";
import { hasLlm, chatStream, translateHeadlineBatch } from "@/lib/llm";
import { cn } from "@/lib/utils";

// 顺序即侧栏子栏目顺序（Layout 的 INTEL_LINKS 与此一致）
const TABS = [
  { key: "investment-news", label: "Investment News", icon: Rss, integrated: true, desc: "12 赛道全球公开 RSS 资讯（集成自 investment-news 仓库）" },
  { key: "news", label: "公开新闻", icon: Newspaper, integrated: false, desc: "汇总关注列表里各个股的近期新闻（公开源）" },
  { key: "semi", label: "Semi动态", icon: MessageSquareText, integrated: true, desc: "nova 抓取并主动推送到广州的 Semi 行业动态" },
  { key: "dingtalk", label: "钉钉群", icon: MessageSquareText, integrated: false, desc: "Nova 本地定时处理并去重后推送的群消息" },
  { key: "filings", label: "A股公告", icon: FileText, integrated: false, desc: "汇总关注列表里各个股的近期公告（东财公开披露）" },
  { key: "events", label: "事件概率", icon: TrendingUp, integrated: true, desc: "全球宏观预期概率 —— 预测市场的公开定价（Polymarket / Kalshi），只读、免登录" },
];

interface Digest { loading?: boolean; text?: string; err?: string; needKey?: boolean }
interface TitleTranslation {
  status: "running" | "done" | "partial" | "need-key";
  done: number;
  total: number;
  error?: string;
}

function InvestmentNewsPanel() {
  const [active, setActive] = useState("ai");
  const [digests, setDigests] = useState<Record<string, Digest>>({});
  const [bulk, setBulk] = useState<{ running: boolean; done: number; total: number }>({ running: false, done: 0, total: 0 });
  const [titleTranslations, setTitleTranslations] = useState<Record<string, TitleTranslation>>({});
  const translationCache = useRef(loadHeadlineTranslationCache(typeof window === "undefined" ? undefined : window.localStorage));
  const latestTranslationRun = useRef(new Map<string, string>());
  const attemptedGeneration = useRef(new Set<string>());
  const [, redrawTranslations] = useState(0);

  // 打开先给存档、后台再刷（见 core/data/useArchiveThenRefresh）——
  // 抓一轮资讯要好几十秒，让人对着转圈等是最没必要的那种等待。
  const { data, err, loading, refreshing, staleNote, refresh } =
    useArchiveThenRefresh<RadarData>((r) => (r ? api.radarRefresh() : api.radar()), []);

  const industries: Industry[] = data?.industries || [];
  const cur = industries.find((i) => i.key === active) || industries[0];
  const hasData = !!data?.generated_at;

  /**
   * 原始 investment-news 的 digest.py 是“每个赛道批量翻译”，这里沿用同一粒度。
   * 已有中文 / 本地缓存先用，只把缺的英文标题发给用户选中的模型。
   * 单批失败继续下一批；最终缺几条就照实报几条，原文始终在。
   */
  const translateIndustry = useCallback(async (ind: Industry, generation: string, force = false) => {
    if (!hasLlm()) {
      setTitleTranslations((s) => ({ ...s, [ind.key]: { status: "need-key", done: 0, total: ind.items.length } }));
      return;
    }
    const runId = `${generation}\u0000${force ? Date.now() : "auto"}`;
    latestTranslationRun.current.set(ind.key, runId);
    const isLatest = () => latestTranslationRun.current.get(ind.key) === runId;
    const cache = translationCache.current;
    const completedThisRun = new Set<string>();
    const doneCount = () => ind.items.filter((it) =>
      hasChinese(it.title) || (force ? completedThisRun.has(it.title) : Boolean(it.zh || cache.has(it.title))),
    ).length;
    const unique = new Map<string, { id: string; title: string }>();
    ind.items.forEach((it, i) => {
      if (!headlineNeedsTranslation(it, cache, force) || unique.has(it.title)) return;
      unique.set(it.title, { id: String(i), title: it.title });
    });
    const targets = [...unique.values()];
    if (!targets.length) {
      setTitleTranslations((s) => ({ ...s, [ind.key]: { status: "done", done: ind.items.length, total: ind.items.length } }));
      return;
    }

    setTitleTranslations((s) => ({ ...s, [ind.key]: { status: "running", done: doneCount(), total: ind.items.length } }));
    const errors: string[] = [];
    for (const batch of splitHeadlineBatches(targets)) {
      try {
        const got = await translateHeadlineBatch(batch);
        for (const item of batch) {
          const zh = got.get(item.id);
          if (zh) {
            cache.set(item.title, zh);
            completedThisRun.add(item.title);
          }
        }
        saveHeadlineTranslationCache(cache, typeof window === "undefined" ? undefined : window.localStorage);
        redrawTranslations((n) => n + 1);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : "翻译失败");
      }
      if (isLatest()) {
        setTitleTranslations((s) => ({ ...s, [ind.key]: { status: "running", done: doneCount(), total: ind.items.length } }));
      }
    }
    if (!isLatest()) return;
    const done = doneCount();
    setTitleTranslations((s) => ({
      ...s,
      [ind.key]: done === ind.items.length
        ? { status: "done", done, total: ind.items.length }
        : { status: "partial", done, total: ind.items.length, error: errors[0] ?? "模型漏回了部分标题" },
    }));
  }, []);

  // 先等背景刷新收口，再自动翻译当前赛道；切换赛道时按需翻译。
  // 250ms 延迟让“存档立即显示 → 后台真刷新”有机会先把 refreshing 立起来，避免对旧快照白跑一轮。
  useEffect(() => {
    if (!cur || !hasData || refreshing) return;
    const generation = data?.generated_at ?? "archive";
    const attemptKey = `${cur.key}\u0000${generation}`;
    if (attemptedGeneration.current.has(attemptKey)) return;
    const timer = window.setTimeout(() => {
      attemptedGeneration.current.add(attemptKey);
      void translateIndustry(cur, generation);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [cur, data?.generated_at, hasData, refreshing, translateIndustry]);

  const genDigest = async (ind: Industry) => {
    if (!hasLlm()) { setDigests((d) => ({ ...d, [ind.key]: { needKey: true } })); return; }
    setDigests((d) => ({ ...d, [ind.key]: { loading: true } }));
    const ctx = ind.items.slice(0, 25).map((it) => `[${it.time}] ${it.source}｜${displayedHeadlineTranslation(it, translationCache.current) || it.title}`).join("\n");
    const prompt =
      `以下是「${ind.name}」赛道近期资讯。请提炼「今日要点」3-5 条：每条一句话（≤40 字），` +
      `只客观陈述重要事件 / 趋势，不推荐标的、不预测涨跌、不构成建议。直接用「- 」列点，不要多余前后缀。\n\n${ctx}`;
    try {
      let acc = "";
      await chatStream([{ role: "user", content: prompt }], `${ind.name}赛道资讯`, {
        onDelta: (t) => { acc += t; setDigests((d) => ({ ...d, [ind.key]: { text: acc } })); },
      });
    } catch (e) {
      setDigests((d) => ({ ...d, [ind.key]: { err: e instanceof ApiError ? e.message : "生成失败" } }));
    }
  };

  // 一键提炼全部赛道要点（串行，带进度；单赛道按需的按钮仍保留）
  const genAll = async () => {
    if (!hasLlm()) { if (cur) setDigests((d) => ({ ...d, [cur.key]: { needKey: true } })); return; }
    const targets = industries.filter((i) => i.items.length > 0);
    setBulk({ running: true, done: 0, total: targets.length });
    for (const ind of targets) {
      await genDigest(ind);
      setBulk((b) => ({ ...b, done: b.done + 1 }));
    }
    setBulk((b) => ({ ...b, running: false }));
  };

  const dg = cur ? digests[cur.key] : undefined;
  const tr = cur ? titleTranslations[cur.key] : undefined;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            {hasData ? `${data!.stats.total_sources} 个公开源 · 近 ${data!.recent_days} 天 · 更新于 ${data!.generated_at}` : "12 赛道 · 106 个公开源"}
          </span>
          {/* 🔴 先给存档、后台刷 ⇒ 用户必须看得出他现在看的是**哪一份**：
              刷新中 = 下面是存档、新的在路上；刷新没成功 = 下面仍是存档，别让他以为是最新的。 */}
          {refreshing && hasData && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
              <Loader2 className="h-3 w-3 animate-spin" /> 刷新中（下面是上次的存档）
            </span>
          )}
          {loading && <span className="text-[11px]">正在取…（这一页还没有存档）</span>}
          {staleNote && <span className="text-[11px] text-warning">{staleNote}</span>}
        </span>
        <div className="flex items-center gap-2">
          {hasData && (
            <button onClick={genAll} disabled={bulk.running || refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-3 py-1.5 text-sm font-medium text-primary shadow-glow hover:bg-primary/25 disabled:opacity-50">
              {bulk.running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {bulk.running ? `提炼中 ${bulk.done}/${bulk.total}` : "一键提炼全部要点"}
            </button>
          )}
          <button onClick={refresh} disabled={refreshing || bulk.running}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {refreshing ? "抓取中…" : "刷新"}
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {err}
        </div>
      )}

      {!hasData && !err ? (
        <div className="rounded-lg border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground/70">
          还没有抓取资讯，点上方<b className="text-foreground">「刷新」</b>拉取（约 20-40 秒）。
        </div>
      ) : (
        <>
          {/* 赛道筛选 —— 暖橙边框 pill */}
          <div className="mb-4 flex flex-wrap gap-2">
            {industries.map((ind) => (
              <button key={ind.key} onClick={() => setActive(ind.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
                  active === ind.key
                    ? "border-primary bg-primary/15 font-medium text-primary shadow-glow"
                    : "border-primary/25 text-muted-foreground hover:border-primary/60 hover:text-foreground",
                )}>
                <span className="h-2 w-2 rounded-full" style={{ background: ind.accent }} />
                {ind.name}<span className="text-muted-foreground/50">{ind.items.length}</span>
              </button>
            ))}
          </div>

          {cur && (
            <>
              <div className="mb-3 flex min-h-7 flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">
                  {tr?.status === "running" ? (
                    <span className="inline-flex items-center gap-1.5 text-primary"><Loader2 className="h-3.5 w-3.5 animate-spin" /> AI 正在翻译标题 {tr.done}/{tr.total}</span>
                  ) : tr?.status === "done" ? (
                    <span className="text-success">AI 标题翻译 {tr.done}/{tr.total}</span>
                  ) : tr?.status === "partial" ? (
                    <span className="text-warning">标题已翻译 {tr.done}/{tr.total}，其余保留原文{tr.error ? `（${tr.error}）` : ""}</span>
                  ) : tr?.status === "need-key" ? (
                    <span>标题尚未翻译 · <Link to="/settings" className="text-primary">先接入 AI</Link></span>
                  ) : (
                    <span>标题翻译将在资讯刷新后自动开始</span>
                  )}
                </span>
                {(tr?.status === "partial" || tr?.status === "done" || tr?.status === "need-key") && (
                  <button
                    onClick={() => void translateIndustry(cur, data?.generated_at ?? "manual", tr.status === "done")}
                    disabled={refreshing}
                    className="text-muted-foreground hover:text-primary disabled:opacity-50"
                  >
                    {tr.status === "done" ? "重新翻译" : "继续翻译"}
                  </button>
                )}
              </div>

              {/* 今日要点总结框（暖橙框） */}
              <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-primary">
                    <Lightbulb className="h-4 w-4" /> 今日要点 · {cur.name}
                  </span>
                  {(dg?.text || dg?.err || dg?.needKey) && (
                    <button onClick={() => genDigest(cur)} className="text-xs text-muted-foreground hover:text-primary">重新提炼</button>
                  )}
                </div>
                {dg?.loading ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> AI 正在读这个赛道的资讯…</p>
                ) : dg?.text ? (
                  <>
                    <div className="prose prose-sm dark:prose-invert max-w-none text-foreground"><ReactMarkdown remarkPlugins={[remarkGfm]}>{dg.text}</ReactMarkdown></div>
                    <div className="mt-2"><SaveNoteButton kind="今日要点" title={`${cur.name} 今日要点`} content={dg.text} /></div>
                  </>
                ) : dg?.needKey ? (
                  <p className="text-sm text-muted-foreground">Agent 还没有可用模型。<Link to="/settings" className="text-primary">先选择模型</Link>，即可一键提炼本赛道今日要点。</p>
                ) : dg?.err ? (
                  <p className="text-sm text-destructive">{dg.err}</p>
                ) : (
                  <button onClick={() => genDigest(cur)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/25">
                    <Sparkles className="h-4 w-4" /> 让 Agent 提炼今日要点
                  </button>
                )}
              </div>

              {/* 资讯列表 */}
              <div className="space-y-2">
                {cur.items.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground/60">近 {data!.recent_days} 天该赛道暂无更新</p>
                ) : (
                  cur.items.map((it, i) => {
                    const zh = displayedHeadlineTranslation(it, translationCache.current);
                    const translated = Boolean(zh && zh !== it.title);
                    return (
                      <a key={i} href={it.url} target="_blank" rel="noreferrer"
                        className="group flex items-start gap-3 border-b border-border/30 pb-2 text-sm last:border-0">
                        <span className="w-24 shrink-0 pt-0.5 font-mono text-xs text-muted-foreground/70">{it.time}</span>
                        <span className="w-20 shrink-0 truncate pt-0.5 text-xs text-muted-foreground">{it.source}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block group-hover:text-primary">{zh || it.title}</span>
                          {translated && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground/65">{it.title}</span>}
                        </span>
                        <ExternalLink className="mt-1 h-3 w-3 shrink-0 text-muted-foreground/0 group-hover:text-primary/60" />
                      </a>
                    );
                  })
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// 关注股公告 / 新闻聚合：从本地关注列表取代码，复用个股接口批量拉取、按时间倒序合并。
// 只做公开信息聚合，标的均为用户自己关注列表里的，不预置、不推荐。
interface FeedRow { code: string; name: string; when: string; title: string; meta?: string; url?: string }
const MAX_ROWS = 60;

function WatchlistFeed({ kind }: { kind: "filings" | "news" }) {
  const [codes, setCodes] = useState<string[]>(loadWatch);
  const [depNote, setDepNote] = useState<string | null>(null);

  // 打开先给存档、后台再刷：这里要按关注列表逐个拉，条数一多就是好几秒
  const load = useCallback(async (doRefresh: boolean): Promise<FeedRow[]> => {
    const cs = codes;
    if (!cs.length) return [];
    setDepNote(null);
    {
      // 股名（一次批量），失败则退回显示代码
      const nameOf: Record<string, string> = {};
      try {
        const quotes = await api.quote(cs.join(","));
        for (const c of cs) if (quotes[c]?.name) nameOf[c] = quotes[c].name;
      } catch { /* 忽略：无股名不影响公告/新闻 */ }

      const out: FeedRow[] = [];
      if (kind === "filings") {
        const res = await Promise.all(
          cs.map((c) => api.announcements(c, doRefresh).then((a) => ({ c, a })).catch(() => ({ c, a: [] as Announcement[] }))),
        );
        for (const { c, a } of res)
          for (const x of a)
            out.push({ code: c, name: nameOf[c] || c, when: x.date, title: x.title.replace(/^[^:：]*[:：]/, ""), meta: x.type, url: x.url });
      } else {
        let dep: string | null = null;
        const res = await Promise.all(
          cs.map((c) =>
            api.news(c, doRefresh).then((n) => ({ c, n })).catch((e) => {
              if (e instanceof ApiError && e.status === 501) dep = e.message;
              return { c, n: [] as NewsItem[] };
            }),
          ),
        );
        for (const { c, n } of res)
          for (const x of n)
            out.push({ code: c, name: nameOf[c] || c, when: x.发布时间 || "", title: x.新闻标题 || "", url: x.新闻链接 });
        if (dep && out.length === 0) setDepNote(dep);
      }
      // 按真实时间倒序：多新闻源的时间字符串格式不统一（有无秒/斜杠日期），字典序会排乱
      const ts = (s: string) => {
        const raw = (s || "").trim();
        let t = Date.parse(raw);
        if (Number.isNaN(t)) t = Date.parse(raw.replace(" ", "T"));
        return Number.isNaN(t) ? 0 : t;
      };
      out.sort((p, q) => ts(q.when) - ts(p.when));
      return out.slice(0, MAX_ROWS);
    }
  }, [kind, codes]);

  const { data, err, loading, refreshing, staleNote, refresh: rerun } =
    useArchiveThenRefresh<FeedRow[]>(load, [kind, codes.join(",")]);
  const rows = data ?? [];

  // 刷新时顺便把关注列表重新读一遍（用户可能刚在别的页面加了自选）
  const refresh = () => {
    const cs = loadWatch();
    if (cs.join(",") !== codes.join(",")) setCodes(cs);   // 变了 → deps 变 → 自动重来
    else rerun();
  };

  if (!codes.length) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground/70">
        还没有关注股票。到<Link to="/daily-review" className="text-primary">「每日复盘」</Link>加自选（6 位代码），这里会汇总它们的{kind === "filings" ? "公告" : "新闻"}。
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Star className="h-3.5 w-3.5 text-primary/70" /> 关注 {codes.length} 只 · 共 {rows.length} 条{kind === "filings" ? "公告" : "新闻"}（近期）
          {/* 🔴 先给存档、后台刷 ⇒ 得让人看得出现在这一屏是哪一份 */}
          {refreshing && rows.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
              <Loader2 className="h-3 w-3 animate-spin" /> 刷新中（下面是上次的存档）
            </span>
          )}
          {loading && <span className="text-[11px]">正在取…（这一页还没有存档）</span>}
          {staleNote && <span className="text-[11px] text-warning">{staleNote}</span>}
        </span>
        <button onClick={refresh} disabled={loading || refreshing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {refreshing ? "拉取中…" : "刷新"}
        </button>
      </div>

      {err && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {err}
        </div>
      )}

      {depNote ? (
        <p className="py-6 text-center text-xs text-warning">{depNote}（安装后新闻即可用）</p>
      ) : loading && rows.length === 0 ? (
        <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> 正在汇总关注股的{kind === "filings" ? "公告" : "新闻"}…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground/60">关注列表里的个股近期暂无{kind === "filings" ? "公告" : "新闻"}。</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <a key={i} href={r.url || undefined} target={r.url ? "_blank" : undefined} rel="noreferrer"
              className={cn("group flex items-baseline gap-3 border-b border-border/30 pb-2 text-sm last:border-0", r.url && "cursor-pointer")}>
              <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground/70">{(r.when || "").slice(kind === "filings" ? 0 : 5, kind === "filings" ? 10 : 16)}</span>
              <span className="w-16 shrink-0 truncate text-xs text-primary/90" title={r.code}>{r.name}</span>
              {kind === "filings" && r.meta && <span className="hidden w-20 shrink-0 truncate text-xs text-muted-foreground sm:block">{r.meta}</span>}
              <span className="flex-1 group-hover:text-primary">{r.title}</span>
              {r.url && <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/0 group-hover:text-primary/60" />}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}


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

function SemiPanel() {
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

function DingTalkGroupPanel() {
  type Feed = { group: string; syncedAt: string; receivedCount: number; duplicateCount: number; messages: Array<{ messageId: string; time: string; sender: string; text: string; duplicateCount: number }> };
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
  const synced = data?.syncedAt ? new Date(data.syncedAt).toLocaleString("zh-CN", { hour12: false }) : "尚未同步";
  const syncDelayed = !!data?.syncedAt && Date.now() - new Date(data.syncedAt).getTime() > 60 * 60 * 1000;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{data?.group || "钉钉群"} · 定时同步约每 30 分钟</span>
        <span>最近同步 {synced}</span>
        {syncDelayed && <span className="text-warning">同步已延迟，请核查定时任务</span>}
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">当前 {data?.messages.length ?? 0} 条</span>
        <span className="rounded-full bg-muted px-2 py-0.5">已合并重复 {data?.duplicateCount ?? 0} 条</span>
        <button onClick={() => void load()} disabled={loading} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 hover:text-primary disabled:opacity-50">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> 刷新展示
        </button>
      </div>
      {err ? (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm text-warning">{err}<p className="mt-1 text-xs">同步任务尚未运行或快照暂不可用；请勿将此状态理解为群内没有新消息。</p></div>
      ) : loading && !data ? (
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> 正在读取钉钉群消息…</p>
      ) : !data?.messages.length ? (
        <div className="rounded-lg border border-dashed border-border/70 p-10 text-center"><p className="text-sm font-medium">暂时没有可展示的群消息</p><p className="mt-2 text-xs text-muted-foreground">同步成功且消息窗口完整后会显示在这里。</p></div>
      ) : (
        <div className="divide-y divide-border/40">
          {data.messages.map((item) => (
            <article key={item.messageId} className="py-4 first:pt-0 last:pb-0">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><time>{item.time}</time><span className="font-medium text-foreground">{item.sender}</span>{item.duplicateCount > 0 && <span className="rounded-full bg-muted px-2 py-0.5">已合并 {item.duplicateCount} 条重复转发</span>}</div>
              <p className="whitespace-pre-wrap break-words text-sm leading-6">{item.text}</p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function Intel() {
  // 当前 Tab 由路由驱动（/intel/:tab），与侧栏子栏目联动；不认识的参数回落到第一个
  const { tab: tabParam } = useParams();
  const navigate = useNavigate();
  const tab = TABS.some((t) => t.key === tabParam) ? tabParam! : TABS[0]!.key;
  const cur = TABS.find((t) => t.key === tab)!;

  useAiPage({
    key: `intel:${tab}`,
    title: `资讯雷达 · ${cur.label}`,
    context: `资讯雷达 · 当前栏目「${cur.label}」。可选栏目：${TABS.map((t) => t.label).join("、")}。`,
    suggestions: ["这个栏目适合看什么", "帮我把要点提炼一下", "有哪些值得追的线索"],
  });

  return (
    <div>
      <PageHeader title="资讯雷达" subtitle="多来源资讯中心：AI 帮你跨源捞资讯、提炼要点" />

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map(({ key, label, icon: Icon, integrated }) => (
          <button key={key} onClick={() => navigate(`/intel/${key}`)}
            className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors",
              tab === key ? "bg-primary/15 font-medium text-primary shadow-glow" : "text-muted-foreground hover:bg-muted/50")}>
            <Icon className="h-4 w-4" /> {label}
            {integrated && <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[9px] font-medium text-primary">集成</span>}
          </button>
        ))}
      </div>

      <GlassCard glow>
        <div className="mb-3 flex items-center gap-2">
          <cur.icon className="h-5 w-5 text-primary" />
          <h3 className="font-semibold">{cur.label}</h3>
          {/* ⚠️ 徽章上印的是**源名**,不是"已接入" —— 别的 tab 接入了别的源,不能共用这一个标签 */}
          {cur.key === "investment-news" && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">investment-news</span>}
          {cur.key === "semi" && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">nova-push</span>}
          {cur.key === "dingtalk" && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">Nova · 去重</span>}
        </div>
        {cur.key === "investment-news" ? (
          <InvestmentNewsPanel />
        ) : cur.key === "semi" ? (
          <SemiPanel />
        ) : cur.key === "dingtalk" ? (
          <DingTalkGroupPanel />
        ) : cur.key === "filings" ? (
          <WatchlistFeed kind="filings" />
        ) : cur.key === "news" ? (
          <WatchlistFeed kind="news" />
        ) : cur.key === "events" ? (
          <EventsPanel />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{cur.desc}</p>
            <div className="mt-4 rounded-lg border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground/70">该数据源规划中——可先用右侧「Investment News」看 12 赛道公开资讯，或用「A 股公告 / 公开新闻」看关注股动态。</div>
          </>
        )}
      </GlassCard>

      <p className="mt-3 text-[11px] text-muted-foreground/60">
        {cur.key === "dingtalk"
          ? "本页展示 Nova 本地处理后推送的群消息，仅作研究线索；群内说法未经公告核验，不等同于已确认事实，也不构成投资建议。"
          : "只做公开信息聚合、不做推荐、不预测涨跌。公告 / 新闻均来自你关注列表里个股的公开披露与公开源；赛道资讯已按合规词表过滤。今日要点由本地 Agent 组织数据，再交给你选择的模型完成推理。"}
      </p>
      <Disclaimer />
    </div>
  );
}

/**
 * 事件概率 —— 预测市场（Polymarket / Kalshi）对宏观事件的公开定价。
 *
 * 🔴 三条渲染纪律：
 *    ① 概率**与结算日同屏**（一个没有结算日的概率说不清是在问哪一天的事）
 *    ② 取数层的「读法」护栏与数字同段，不改写、不省略
 *    ③ 只取到一部分时明说 partial —— 否则用户以为"就这么几条"
 */
function EventsPanel() {
  const { data, err, loading, refreshing, staleNote, refresh } =
    useArchiveThenRefresh<MacroProbability>((r) => api.macroProbability(r), []);

  if (loading) return <p className="mt-4 text-sm text-muted-foreground">正在取…（这一页还没有存档）</p>;
  if (err) return <p className="mt-4 text-sm text-destructive">{err}</p>;
  if (!data || data.items.length === 0)
    return <p className="mt-4 text-sm text-muted-foreground">这一轮没取到合约报价（上游可能暂时不可用），不代表没有相关事件。</p>;

  const byTopic = new Map<string, MacroProbItem[]>();
  for (const it of data.items) byTopic.set(it.topic, [...(byTopic.get(it.topic) ?? []), it]);

  return (
    <div className="mt-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <span>{`共 ${data.items.length} 份合约`}</span>
        {data.partial && <span className="text-warning">· 部分源没取到，这不是完整清单</span>}
        <span className="text-[11px] text-muted-foreground/60">{`更新于 ${data.updated}`}</span>
        {refreshing && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
            <Loader2 className="h-3 w-3 animate-spin" /> 刷新中（下面是上次的存档）
          </span>
        )}
        {staleNote && <span className="text-[11px] text-warning">{staleNote}</span>}
        <button onClick={refresh} disabled={refreshing}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-0.5 text-[11px] hover:text-foreground disabled:opacity-50">
          <RefreshCw className="h-3 w-3" /> 刷新
        </button>
      </p>

      {[...byTopic.entries()].map(([topic, items]) => (
        <div key={topic} className="mt-4">
          <h4 className="mb-2 text-xs font-semibold text-muted-foreground">{topic}</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] text-muted-foreground/70">
                <tr>
                  <th className="px-2 py-1 text-left font-normal">合约在问什么</th>
                  <th className="px-2 py-1 text-right font-normal">概率</th>
                  <th className="px-2 py-1 text-left font-normal">结算日</th>
                  <th className="px-2 py-1 text-right font-normal">24h 成交量</th>
                  <th className="px-2 py-1 text-left font-normal">来源</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={`${it.title}-${i}`} className="border-t border-border/40">
                    <td className="px-2 py-2">{it.title}{it.leg && <span className="ml-1 text-[11px] text-muted-foreground/60">（{it.leg}）</span>}</td>
                    <td className="px-2 py-2 text-right font-mono font-semibold">
                      {it.prob === null ? "—" : `${(it.prob * 100).toFixed(1)}%`}
                    </td>
                    <td className="px-2 py-2 font-mono text-[11px] text-muted-foreground">{it.settle || "—"}</td>
                    <td className="px-2 py-2 text-right font-mono text-[11px] text-muted-foreground">
                      {it.volume === null ? "—" : it.volume.toLocaleString("en-US")}
                    </td>
                    <td className="px-2 py-2 text-[11px] text-muted-foreground">{it.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* 🔴 护栏与数字同屏 —— 照抄取数层原话，不改写 */}
      {data.how_to_read.length > 0 && (
        <div className="mt-4 rounded-lg border border-border/60 bg-muted/20 p-3">
          <p className="mb-1 text-xs font-semibold text-muted-foreground">怎么读这组数</p>
          {data.how_to_read.map((h: string) => (
            <p key={h} className="text-[11px] leading-relaxed text-muted-foreground/80">{h}</p>
          ))}
        </div>
      )}
    </div>
  );
}
