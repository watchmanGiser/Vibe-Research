import fs from "node:fs";

const SNAPSHOT_FILE = process.env.SEMI_SNAPSHOT_FILE?.trim() || "/opt/vibe-research/shared/semi/latest.json";

export class SemiUpstreamError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

type SemiSnapshot = {
  pushed_at?: string;
  health?: unknown;
  status?: unknown;
  tweets?: { items?: unknown[]; count?: number; total?: number; translated?: number; [key: string]: unknown };
};

function readSnapshot(): SemiSnapshot {
  try {
    const raw = fs.readFileSync(SNAPSHOT_FILE, "utf8");
    return JSON.parse(raw) as SemiSnapshot;
  } catch (error) {
    throw new SemiUpstreamError(`尚未收到 nova 推送的 semi 数据：${error instanceof Error ? error.message : String(error)}`, 503);
  }
}

export async function fetchSemi(pathname: string, params?: URLSearchParams): Promise<unknown> {
  const snapshot = readSnapshot();
  if (pathname === "/api/health") return { ...(snapshot.health as object ?? {}), transport: "nova-push", pushed_at: snapshot.pushed_at };
  if (pathname === "/api/status") return { ...(snapshot.status as object ?? {}), transport: "nova-push", pushed_at: snapshot.pushed_at };
  if (pathname === "/api/tweets") {
    const source = snapshot.tweets ?? { items: [] };
    const limitRaw = Number(params?.get("limit") ?? 100);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.trunc(limitRaw))) : 100;
    const since = params?.get("since")?.trim();
    const items = Array.isArray(source.items) ? source.items.filter((item) => {
      if (!since || !item || typeof item !== "object") return true;
      const created = String((item as { created_at?: unknown }).created_at ?? "");
      return !created || created >= since;
    }).slice(0, limit) : [];
    return { ...source, items, count: items.length, transport: "nova-push", pushed_at: snapshot.pushed_at };
  }
  throw new SemiUpstreamError("不支持的 semi 数据路径", 400);
}
