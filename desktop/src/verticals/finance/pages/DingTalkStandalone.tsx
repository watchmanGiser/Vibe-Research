import { useEffect, useState } from "react";
import { Lightbulb, Moon, Sun } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { storageGet, storageSet } from "@/lib/storage";
import { DingTalkGroupPanel } from "./SemiPanels";

/** 独立只读入口，直接使用公开消息与总结，不加载个人资料或工作台外壳。 */
export function DingTalkStandalone() {
  const [theme, setTheme] = useState<"dark" | "light">(() => storageGet("vra-theme") === "light" ? "light" : "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    storageSet("vra-theme", theme);
  }, [theme]);
  return (
    <main aria-label="击球区情报" className="mx-auto min-h-screen max-w-[1920px] px-3 py-4 sm:px-6 sm:py-5">
      <header className="mb-5 flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10"><Lightbulb className="h-6 w-6 text-primary" /></span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">击球区情报</h1>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">原始消息完整归档，观点总结同步浏览</p>
          </div>
        </div>
        <button type="button" aria-label={theme === "dark" ? "切换为浅色" : "切换为深色"} onClick={() => setTheme(value => value === "dark" ? "light" : "dark")}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border bg-background/30 px-3 py-2 text-xs text-muted-foreground hover:text-primary">
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}<span className="hidden sm:inline">{theme === "dark" ? "浅色" : "深色"}</span>
        </button>
      </header>
      <GlassCard><DingTalkGroupPanel standalone /></GlassCard>
      <p className="mt-3 text-[11px] leading-5 text-muted-foreground/70">本页保留完整去重原文与第三方观点总结；内容未经公告核验，不等同于已确认事实，也不构成投资建议。</p>
    </main>
  );
}
