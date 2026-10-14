import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileText, Loader2, X } from 'lucide-react';
import type { DingTalkDocument } from '../lib/dingtalk_content';

const statusText: Record<DingTalkDocument['status'], string> = {
  partial: '部分页面未识别，暂缓自动整理', pending: '正在下载并解析', ready: '已下载 · 正文已解析', download_failed: '下载暂未成功，原链接已保留',
  parse_failed: '原文件已保留，正文解析暂未成功', unsupported: '此文档来源暂不支持自动下载',
};
const safe = (url?: string) => !!url && /^\/dingtalk\/documents\/[a-f0-9]{64}(?:-[a-f0-9]{64})?(?:-preview|-page-\d{3})?\.(?:pdf|docx|doc|txt|jpg)$/.test(url);

function DocumentPreview({ document, close }: { document: DingTalkDocument; close: () => void }) {
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<'pages' | 'text'>(document.previewImages?.length ? 'pages' : 'text');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const images = (document.previewImages || []).filter(safe);
  useEffect(() => {
    const current = dialog.current;
    current?.showModal();
    return () => { current?.close(); };
  }, []);
  useEffect(() => {
    if (mode !== 'text' || text || !safe(document.textUrl)) return;
    const controller = new AbortController();
    fetch(document.textUrl!, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw Error('正文暂时无法加载');
      setText(await response.text());
    }).catch(reason => { if (reason.name !== 'AbortError') setError('正文暂时无法加载，请稍后重试'); });
    return () => controller.abort();
  }, [mode, text, document.textUrl]);
  return <dialog ref={dialog} onCancel={close} aria-label={`文档预览：${document.name}`}
    className="m-auto flex max-h-[94dvh] w-[calc(100%-1rem)] max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/65">
    <div className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3">
      <div className="min-w-0 flex-1"><h2 className="break-words text-sm font-semibold">{document.name}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{document.pageCount ? `共 ${document.pageCount} 页` : '文档正文预览'}</p></div>
      <button type="button" onClick={close} aria-label="关闭文档预览" className="rounded-md p-1 hover:bg-muted"><X className="h-5 w-5" /></button>
    </div>
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-xs">
      {images.length > 0 && <button type="button" onClick={() => setMode('pages')} aria-pressed={mode === 'pages'} className="rounded-md border border-border px-3 py-1.5">页面预览</button>}
      <button type="button" onClick={() => setMode('text')} aria-pressed={mode === 'text'} className="rounded-md border border-border px-3 py-1.5">正文预览</button>
      {safe(document.previewUrl) && <a href={document.previewUrl} target="_blank" rel="noopener noreferrer" className="text-primary">打开完整预览</a>}
      {safe(document.url) && <a href={document.url} download={document.name} className="ml-auto inline-flex items-center gap-1 text-primary"><Download className="h-3.5 w-3.5" />下载原文件</a>}
    </div>
    <div className="min-h-0 min-w-0 overflow-auto bg-muted/15 p-3 sm:p-5">
      {mode === 'pages' && images[page] && <img src={images[page]} alt={`${document.name} 第 ${page + 1} 页`} className="mx-auto h-auto w-full max-w-3xl bg-white shadow-sm" />}
      {mode === 'text' && (error ? <p role="alert" className="p-3 text-sm">{error}</p> : text ?
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7">{text}</pre> : <p className="flex items-center gap-2 p-3 text-sm"><Loader2 className="h-4 w-4 animate-spin" />正在加载正文…</p>)}
    </div>
    {mode === 'pages' && <div className="flex shrink-0 items-center justify-center gap-4 border-t border-border px-3 py-2 text-xs">
      <button type="button" onClick={() => setPage(value => value - 1)} disabled={page === 0} aria-label="上一页" className="rounded-md border border-border p-1.5 disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
      <span>第 {page + 1} / {images.length} 页{document.pageCount && document.pageCount > images.length ? `（原文件共 ${document.pageCount} 页）` : ''}</span>
      <button type="button" onClick={() => setPage(value => value + 1)} disabled={page + 1 >= images.length} aria-label="下一页" className="rounded-md border border-border p-1.5 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
    </div>}
  </dialog>;
}

export function DingTalkDocumentCard({ document }: { document: DingTalkDocument }) {
  const [open, setOpen] = useState(false);
  return <div className="min-w-0 rounded-lg border border-border/70 bg-background px-3 py-3">
    <div className="flex min-w-0 items-start gap-2"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{document.name}</p>
        <p className="mt-1 text-xs text-muted-foreground">{statusText[document.status]}{document.pageCount ? ` · ${document.pageCount} 页` : ''}</p>{!!document.unreadablePages?.length && <p className="mt-1 text-xs text-muted-foreground">第 {document.unreadablePages.join('、')} 页文字识别未完成，可查看页面预览。</p>}</div></div>
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
      {['ready', 'partial'].includes(document.status) && safe(document.textUrl) && <button type="button" onClick={() => setOpen(true)} className="rounded-md border border-primary/25 px-3 py-1.5 text-primary hover:bg-primary/10">预览文档</button>}
      {safe(document.url) && <a href={document.url} download={document.name} className="inline-flex items-center gap-1 text-primary"><Download className="h-3.5 w-3.5" />下载原文件</a>}
    </div>
    {open && <DocumentPreview document={document} close={() => setOpen(false)} />}
  </div>;
}
