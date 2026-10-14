#!/usr/bin/env node
/**
 * 每次读取指定群最近窗口，并在共享快照中按消息 ID 与长文本指纹去重。
 * 不保存 DWS 原始响应、凭据或 reaction；仅接受完整查询，避免部分分页覆盖进度。
 */
import { mergeMessageHistory } from "./dingtalk-duplicates.mjs";
import { windowPaused, pausedResult, assertUpdateWindow, updateDeadline } from "./dingtalk-schedule.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

if (windowPaused()) { console.log(JSON.stringify(pausedResult())); process.exit(0); }
const group = process.env.DINGTALK_GROUP_NAME?.trim();
const expectedConversationId = process.env.DINGTALK_CONVERSATION_ID?.trim();
if (!group || !expectedConversationId) throw new Error("缺少本地群名或会话 ID 配置，取消同步");
const snapshotFile = process.env.DINGTALK_SEMI_SNAPSHOT_FILE || path.join(os.homedir(), ".local", "share", "vibe-research", "dingtalk.json");
const dws = process.env.DWS_BIN || "dws";
const now = new Date();
const iso = (date) => date.toISOString();

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
const result = spawnSync(dws, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: Math.max(1, updateDeadline(5 * 60 * 1000) - Date.now()) });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`DWS 查询失败（退出码 ${result.status}），保留旧快照`);
const response = JSON.parse(result.stdout);
if (response.complete !== true || response.partial || response.truncated || response.failedCount > 0 || !Array.isArray(response.messages)) {
  throw new Error(`消息查询不完整，保留旧快照。complete=${response.complete}, partial=${response.partial}, truncated=${response.truncated}, failedCount=${response.failedCount}`);
}
if (response.messages.some((m) => !m || m.conversationId !== expectedConversationId)) {
  throw new Error("会话身份校验失败，保留旧快照");
}

const incoming = response.messages.filter(source => typeof source.messageId === "string" && typeof source.text === "string" && source.text.trim()).map(source => ({
  messageId: source.messageId, time: String(source.createTime || ""), sender: String(source.sender || "未知发送者"), text: source.text.trim(), duplicateCount: 0,
}));
const resultHistory = mergeMessageHistory(old?.messages || [], incoming);
const messages = resultHistory.messages;

const snapshot = {
  group,
  conversationId: expectedConversationId,
  syncedAt: iso(now),
  windowStart: start.toISOString(),
  windowEnd: iso(now),
  receivedCount: response.messages.length,
  duplicateCount: Math.max(old?.duplicateCount || 0, resultHistory.duplicateCount),
  messages,
};
assertUpdateWindow();
fs.mkdirSync(path.dirname(snapshotFile), { recursive: true, mode: 0o700 });
const temp = `${snapshotFile}.${process.pid}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
fs.renameSync(temp, snapshotFile);
console.log(JSON.stringify({ group, added: resultHistory.added, received: response.messages.length, stored: messages.length, duplicatesThisRun: resultHistory.merged, syncedAt: snapshot.syncedAt }));
