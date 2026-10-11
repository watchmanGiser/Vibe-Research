import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("增量筛选兼容 Unix 秒与带时区日期，拒绝无效截止时间", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-semi-feed-"));
  const original = process.env.SEMI_SNAPSHOT_FILE;
  try {
    const file = process.env.SEMI_SNAPSHOT_FILE = path.join(root, "feed.json");
    fs.writeFileSync(file, JSON.stringify({ tweets: { items: [
      { id: "before", created_ts: Date.parse("2026-10-10T00:00:00Z") / 1000 },
      { id: "after", created_ts: Date.parse("2026-10-11T01:00:00Z") / 1000 },
      { id: "date", created_at: "2026-10-11T09:00:00+08:00" },
    ] } }));
    const { fetchSemi, SemiUpstreamError } = await import("../src/finance/semi.ts");
    const result = await fetchSemi("/api/tweets", new URLSearchParams({ since: "2026-10-11T00:00:00Z" })) as { items: { id: string }[]; count: number };
    assert.deepEqual(result.items.map((r) => r.id), ["after", "date"]);
    assert.equal(result.count, 2);
    await assert.rejects(fetchSemi("/api/tweets", new URLSearchParams({ since: "bad-date" })), SemiUpstreamError);
  } finally {
    if (original === undefined) delete process.env.SEMI_SNAPSHOT_FILE;
    else process.env.SEMI_SNAPSHOT_FILE = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
