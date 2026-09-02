import { useState } from "react";
import { ExternalLink, RadioTower, RefreshCw } from "lucide-react";

const REALTIME_URL = "/realtime/";

export function Realtime() {
  const [frameKey, setFrameKey] = useState(0);
  const [loading, setLoading] = useState(true);

  function refreshFrame() {
    setLoading(true);
    setFrameKey((key) => key + 1);
  }

  return (
    <section className="flex h-full min-h-[560px] flex-col gap-3">
      <header className="glass flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <RadioTower className="h-5 w-5" />
            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-background" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-bold">成交分析实时版</h1>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                实时更新
              </span>
            </div>
            <p className="truncate text-xs text-muted-foreground">沪深市场成交与资金变化，数据由实时分析服务持续刷新</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refreshFrame}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
          <a
            href={REALTIME_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            独立打开
          </a>
        </div>
      </header>

      <div className="glass relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-border/60">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin text-primary" />
              正在连接实时数据服务…
            </div>
          </div>
        )}
        <iframe
          key={frameKey}
          src={REALTIME_URL}
          title="成交分析实时版"
          className="h-full w-full bg-white"
          onLoad={() => setLoading(false)}
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </section>
  );
}
