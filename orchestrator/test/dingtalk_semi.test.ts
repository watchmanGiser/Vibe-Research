import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fetchDingTalkGroup, DingTalkSnapshotError } from "../src/dingtalk_semi.ts";

test("只读去重结果并限制数量，不泄露内部会话及重复消息 ID", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-dingtalk-api-"));
  const previous = process.env.DINGTALK_SEMI_SNAPSHOT_FILE;
  try {
    process.env.DINGTALK_SEMI_SNAPSHOT_FILE = path.join(dir, "snapshot.json");
    assert.throws(() => fetchDingTalkGroup(), DingTalkSnapshotError);
    fs.writeFileSync(process.env.DINGTALK_SEMI_SNAPSHOT_FILE, JSON.stringify({
      group: "测试群", conversationId: "internal-conversation", syncedAt: "2026-09-27T00:00:00.000Z",
      windowStart: "internal-window", receivedCount: 2, duplicateCount: 1,
      messages: [{ messageId: "item-1", time: "2026-09-27T00:00:00Z", sender: "甲", text: "测试消息", duplicateCount: 1,
        duplicateMessageIds: ["internal-duplicate"], latestDuplicateTime: "internal-time" }],
    }));
    const feed = fetchDingTalkGroup(1);
    assert.deepEqual(Object.keys(feed).sort(), ["duplicateCount", "group", "messages", "receivedCount", "syncedAt"]);
    assert.deepEqual(feed.messages, [{ messageId: createHash("sha256").update("item-1").digest("hex"), time: "2026-09-27T00:00:00Z", sender: "甲", text: "测试消息", duplicateCount: 1 }]);
    assert.equal(fetchDingTalkGroup(0).messages.length, 1);
    fs.writeFileSync(process.env.DINGTALK_SEMI_SNAPSHOT_FILE, JSON.stringify({ group: "测试群", messages: [] }));
    assert.throws(() => fetchDingTalkGroup(), DingTalkSnapshotError);
  } finally {
    if (previous === undefined) delete process.env.DINGTALK_SEMI_SNAPSHOT_FILE;
    else process.env.DINGTALK_SEMI_SNAPSHOT_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP 路由必须鉴权；快照缺失是 503，结果仅返回展示字段", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-dingtalk-http-"));
  const previous = process.env.DINGTALK_SEMI_SNAPSHOT_FILE;
  const token = "test-dingtalk-token-0123456789";
  const { createApiServer } = await import("../src/api.ts");
  const server = createApiServer({ repoRoot: path.resolve("."), dataRoot: root, python: "python3", node: process.execPath, providerEnvKey: null }, { token });
  try {
    process.env.DINGTALK_SEMI_SNAPSHOT_FILE = path.join(root, "feed.json");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const read = (withAuth: boolean) => fetch(`${base}/semi/dingtalk?limit=1`, { headers: withAuth ? { Authorization: `Bearer ${token}` } : {} });
    assert.equal((await read(false)).status, 401);
    assert.equal((await read(true)).status, 503);
    fs.writeFileSync(process.env.DINGTALK_SEMI_SNAPSHOT_FILE, JSON.stringify({
      group: "测试群", conversationId: "private-conversation", syncedAt: new Date().toISOString(), receivedCount: 1, duplicateCount: 0,
      messages: [{ messageId: "hash-id", time: new Date().toISOString(), sender: "甲", text: "测试文本", duplicateCount: 0, duplicateMessageIds: ["secret-id"] }],
    }));
    const response = await read(true);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.doesNotMatch(body, /private-conversation|secret-id|hash-id/);
    assert.equal(JSON.parse(body).messages.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.DINGTALK_SEMI_SNAPSHOT_FILE;
    else process.env.DINGTALK_SEMI_SNAPSHOT_FILE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
