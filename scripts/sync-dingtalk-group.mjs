#!/usr/bin/env node
/**
 * 每次读取指定群最近窗口，并在共享快照中按消息 ID 与长文本指纹去重。
 * 不保存 DWS 原始响应、凭据或 reaction；仅接受完整查询，避免部分分页覆盖进度。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const group = process.env.DINGTALK_GROUP_NAME?.trim();
const expectedConversationId = process.env.DINGTALK_CONVERSATION_ID?.trim();
if (!group || !expectedConversationId) throw new Error("缺少本地群名或会话 ID 配置，取消同步");
const snapshotFile = process.env.DINGTALK_SEMI_SNAPSHOT_FILE || path.join(os.homedir(), ".local", "share", "vibe-research", "dingtalk.json");
const dws = process.env.DWS_BIN || "dws";
const now = new Date();
const iso = (date) => date.toISOString();
const norm = (text) => text.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");
const fingerprint = (text) => createHash("sha256").update(norm(text)).digest("hex");

let old = null;
try { old = JSON.parse(fs.readFileSync(snapshotFile, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
if (old && (old.group !== group || old.conversationId !== expectedConversationId || !Array.isArray(old.messages))) {
  throw new Error("本地快照会话身份不匹配，保留旧快照");
}
const prior = old?.syncedAt ? new Date(old.syncedAt) : new Date(now.getTime() - 24 * 60 * 60 * 1000);
if (!Number.isFinite(prior.getTime())) throw new Error("本地快照时间无效，保留旧快照");
// 重叠 10 分钟，弥补服务端索引延迟；稳定 ID 再消除窗口重叠带来的重复。
const start = new Date(Math.max(now.getTime() - 30 * 24 * 60 * 60 * 1000, prior.getTime() - 10 * 60 * 1000));
const args = ["chat", "+chat-messages", "--group", group, "--start", start.toISOString(), "--page-all", "--max-items", "1000", "--no-reactions", "--format", "json"];
const result = spawnSync(dws, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60 * 1000 });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`DWS 查询失败（退出码 ${result.status}），保留旧快照`);
const response = JSON.parse(result.stdout);
if (response.complete !== true || response.partial || response.truncated || response.failedCount > 0 || !Array.isArray(response.messages)) {
  throw new Error(`消息查询不完整，保留旧快照。complete=${response.complete}, partial=${response.partial}, truncated=${response.truncated}, failedCount=${response.failedCount}`);
}
if (response.messages.some((m) => !m || m.conversationId !== expectedConversationId)) {
  throw new Error("会话身份校验失败，保留旧快照");
}

const byId = new Map((old?.messages || []).map((m) => [m.messageId, m]));
const seenIds = new Set();
for (const m of byId.values()) { seenIds.add(m.messageId); for (const id of m.duplicateMessageIds || []) seenIds.add(id); }
const byFingerprint = new Map();
for (const m of byId.values()) if (norm(m.text).length >= 100) byFingerprint.set(fingerprint(m.text), m);
let duplicatesThisRun = 0;
for (const source of response.messages) {
  const messageId = String(source.messageId || "");
  const text = typeof source.text === "string" ? source.text.trim() : "";
  if (!messageId || !text || seenIds.has(messageId)) continue;
  const fp = norm(text).length >= 100 ? fingerprint(text) : "";
  const duplicate = fp ? byFingerprint.get(fp) : null;
  if (duplicate) {
    duplicate.duplicateCount = (duplicate.duplicateCount || 0) + 1;
    duplicate.duplicateMessageIds = [...new Set([...(duplicate.duplicateMessageIds || []), messageId])];
    seenIds.add(messageId);
    if (source.createTime > duplicate.time) duplicate.latestDuplicateTime = source.createTime;
    duplicatesThisRun++;
    continue;
  }
  const message = {
    messageId,
    time: String(source.createTime || ""),
    sender: String(source.sender || "未知发送者"),
    text,
    duplicateCount: 0,
  };
  byId.set(messageId, message);
  seenIds.add(messageId);
  if (fp) byFingerprint.set(fp, message);
}
const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const messages = [...byId.values()].filter((m) => m.time >= cutoff).sort((a, b) => b.time.localeCompare(a.time));
const snapshot = {
  group,
  conversationId: expectedConversationId,
  syncedAt: iso(now),
  windowStart: start.toISOString(),
  windowEnd: iso(now),
  receivedCount: response.messages.length,
  duplicateCount: (old?.duplicateCount || 0) + duplicatesThisRun,
  messages,
};
fs.mkdirSync(path.dirname(snapshotFile), { recursive: true, mode: 0o700 });
const temp = `${snapshotFile}.${process.pid}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
fs.renameSync(temp, snapshotFile);
console.log(JSON.stringify({ group, received: response.messages.length, stored: messages.length, duplicatesThisRun, syncedAt: snapshot.syncedAt }));
