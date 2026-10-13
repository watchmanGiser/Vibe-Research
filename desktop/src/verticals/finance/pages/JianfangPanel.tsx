import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, Loader2, RefreshCw, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { weiboTime, type JianfangFeed, type WeiboPost } from '@/lib/weibo';

function PostBody({ item }: { item: WeiboPost }) {
  const long = item.text.length > 600;
  const body = <p className="whitespace-pre-wrap break-words text-sm leading-7">{item.text}</p>;
  return <>
    {long ? <details className="group/body"><summary className="cursor-pointer text-xs text-primary"><span className="mb-1 block whitespace-pre-wrap break-words text-sm leading-7 text-foreground group-open/body:hidden">{item.text.slice(0, 240)}…</span>展开全文 · {item.text.length} 字</summary><div className="mt-2">{body}</div></details> : body}
    {!item.textComplete && <p className="mt-2 text-xs text-warning">当前为节选，全文可查看原帖。</p>}
    {item.images.length > 0 && <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {item.images.map((src, i) => <a key={src} href={src} target="_blank" rel="noreferrer" className="block min-w-0 overflow-hidden rounded-lg border border-border/50">
        <img src={src} alt={`${item.author} 微博配图 ${i + 1}`} referrerPolicy="no-referrer" loading="lazy" decoding="async" className="h-40 w-full bg-muted/20 object-contain" onError={e => { e.currentTarget.alt = '图片暂未加载，请查看原帖'; }} />
      </a>)}
    </div>}
  </>;
}
export function JianfangPostCard({ item }: { item: WeiboPost }) {
  return <article className="py-5 first:pt-0 last:pb-0">
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium text-primary">{item.author}</span>
      <time dateTime={item.time}>{weiboTime(item.time)}</time>
      {item.pinned && <span className="rounded-full bg-muted px-2 py-0.5">源主页置顶</span>}
      <a href={item.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-primary hover:underline">查看原帖 <ExternalLink className="h-3 w-3" /></a>
    </div>
    <PostBody item={item} />
    {item.repost && <blockquote className="mt-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>转发 @{item.repost.author}</span><time dateTime={item.repost.time}>{weiboTime(item.repost.time)}</time>
        <a href={item.repost.url} target="_blank" rel="noreferrer" className="ml-auto text-primary hover:underline">原微博</a>
      </div><PostBody item={item.repost} />
    </blockquote>}
    <p className="mt-3 text-[11px] text-muted-foreground/70">赞 {item.likes} · 评 {item.comments} · 转 {item.reposts}{item.source && ` · ${item.source}`}</p>
  </article>;
}
export function JianfangFeedStatus({ data }: { data: JianfangFeed }) {
  const stale = Date.now() - Date.parse(data.syncedAt) > 45 * 60 * 1000;
  return <>
    <p className="text-xs text-muted-foreground">交易者简放 · 微博 · 每 15 分钟同步 · 已记录 {data.total} 条</p>
    <p className="mt-1 text-[11px] text-muted-foreground">最近成功同步 {weiboTime(data.syncedAt)}（北京时间）</p>
    {(data.error || stale) && <div role="status" className="mt-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
      {data.error || '同步时间已超过 45 分钟，当前展示上次成功保存的内容。'}
    </div>}
  </>;
}
export function JianfangPanel() {
  const [data, setData] = useState<JianfangFeed | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true); setErr('');
    try { const feed = await api.jianfang({ offset, q: query }); if (request === latest.current) setData(feed); }
    catch (e) { if (request === latest.current) setErr(e instanceof Error ? e.message : '读取微博内容失败'); }
    finally { if (request === latest.current) setLoading(false); }
  }, [offset, query]);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 60_000); return () => { latest.current++; window.clearInterval(timer); }; }, [load]);
  return <div>
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>{data ? <JianfangFeedStatus data={data} /> : <p className="text-xs text-muted-foreground">交易者简放 · 微博公开内容</p>}</div>
      <div className="flex items-center gap-3 text-xs">
        <a href="https://www.weibo.com/u/1357064103" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">微博主页 <ExternalLink className="h-3 w-3" /></a>
        <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 disabled:opacity-50">{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}刷新展示</button>
      </div>
    </div>
    <form onSubmit={e => { e.preventDefault(); setOffset(0); setQuery(input.trim()); }} className="mb-4 flex gap-2">
      <input aria-label="搜索简放微博" maxLength={200} placeholder="搜索已记录的微博正文" value={input} onChange={e => setInput(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-background/50 px-3 py-2 text-sm" />
      <button type="submit" className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs"><Search className="h-3.5 w-3.5" />搜索</button>
    </form>
    {err && <div role="alert" className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><AlertCircle className="h-4 w-4 shrink-0" />{err}{data && '，以下为此前已加载的内容。'}</div>}
    {loading && !data ? <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取简放微博…</p> : data && !data.items.length ? <p className="py-8 text-center text-sm text-muted-foreground">{query ? '没有匹配的已记录微博。' : '尚未记录微博内容。'}</p> : null}
    {data && <div className="divide-y divide-border/40">{data.items.map(item => <JianfangPostCard key={item.id} item={item} />)}</div>}
    {data && (data.offset > 0 || data.hasMore) && <div className="mt-5 flex items-center justify-between gap-3 text-xs">
      <button disabled={!data.offset || loading} onClick={() => setOffset(Math.max(0, data.offset - data.limit))} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">上一页</button>
      <span>共 {data.filteredTotal} 条 · 第 {Math.floor(data.offset / data.limit) + 1} 页</span>
      <button disabled={!data.hasMore || loading} onClick={() => setOffset(data.offset + data.limit)} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">下一页</button>
    </div>}
  </div>;
}
