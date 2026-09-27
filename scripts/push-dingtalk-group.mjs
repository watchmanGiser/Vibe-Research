#!/usr/bin/env node
/** 本机用 DWS 拉取并去重钉钉消息，再原子推送快照到广州服务器。 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const syncScript = path.join(scriptDir, "sync-dingtalk-group.mjs");
const localFile = process.env.DINGTALK_LOCAL_SNAPSHOT_FILE || path.join(os.homedir(), ".local", "share", "vibe-research", "dingtalk.json");
const host = process.env.DINGTALK_PUSH_HOST?.trim();
if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) throw new Error("请配置有效的推送服务器主机名");
const user = process.env.DINGTALK_PUSH_USER || "ubuntu";
if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(user)) throw new Error("推送服务器用户无效");
const key = process.env.DINGTALK_PUSH_SSH_KEY?.trim();
if (!key) throw new Error("请在 Nova 本机配置推送用 SSH 密钥路径");
const remoteFile = process.env.DINGTALK_REMOTE_SNAPSHOT_FILE || "/opt/vibe-research/shared/semi/dingtalk.json";
if (!/^\/opt\/vibe-research\/shared\/semi\/[A-Za-z0-9._-]+$/.test(remoteFile)) throw new Error("远程快照路径不在允许目录内");
if (!fs.existsSync(key)) throw new Error(`找不到 SSH 密钥文件：${key}`);

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: "utf8", stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${bin} 失败，退出码 ${result.status}`);
}

fs.mkdirSync(path.dirname(localFile), { recursive: true, mode: 0o700 });
run(process.execPath, [syncScript], {
  env: { ...process.env, DINGTALK_SEMI_SNAPSHOT_FILE: localFile },
});
if (!fs.existsSync(localFile) || fs.statSync(localFile).size === 0) throw new Error("本地快照不存在或为空，取消推送");

// 先传到目标目录中的临时名；只有传输成功且文件非空才原子替换正式快照。
const localSnapshot = JSON.parse(fs.readFileSync(localFile, "utf8"));
if (!localSnapshot || localSnapshot.conversationId !== process.env.DINGTALK_CONVERSATION_ID ||
    typeof localSnapshot.group !== "string" || !localSnapshot.group ||
    typeof localSnapshot.receivedCount !== "number" || !Number.isInteger(localSnapshot.receivedCount) || localSnapshot.receivedCount < 0 ||
    typeof localSnapshot.duplicateCount !== "number" || !Number.isInteger(localSnapshot.duplicateCount) || localSnapshot.duplicateCount < 0 ||
    !Array.isArray(localSnapshot.messages) || !Number.isFinite(Date.parse(localSnapshot.syncedAt))) {
  throw new Error("本地快照格式无效，取消推送");
}
if (localSnapshot.messages.some((m) => !m || typeof m.messageId !== "string" || !m.messageId ||
    typeof m.time !== "string" || typeof m.sender !== "string" || typeof m.text !== "string" ||
    !Number.isInteger(m.duplicateCount) || m.duplicateCount < 0)) {
  throw new Error("本地消息格式无效，取消推送");
}
const publicSnapshot = {
  group: localSnapshot.group,
  syncedAt: localSnapshot.syncedAt,
  receivedCount: localSnapshot.receivedCount,
  duplicateCount: localSnapshot.duplicateCount,
  messages: localSnapshot.messages.map((item) => ({
    messageId: createHash("sha256").update(String(item.messageId)).digest("hex"),
    time: item.time, sender: item.sender, text: item.text, duplicateCount: item.duplicateCount,
  })),
};
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "vra-dingtalk-push-"));
const publishFile = path.join(stage, "dingtalk.json");
fs.writeFileSync(publishFile, `${JSON.stringify(publicSnapshot)}\n`, { mode: 0o600 });
const remoteTemp = `${remoteFile}.uploading-${process.pid}-${Date.now()}`;
try {
run("scp", [
  "-F", "/dev/null", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=15", "-i", key,
  publishFile, `${user}@${host}:${remoteTemp}`,
]);
const remoteCommand = `test -s '${remoteTemp}' && chmod 0640 '${remoteTemp}' && mv -f -- '${remoteTemp}' '${remoteFile}'`;
run("ssh", [
  "-F", "/dev/null", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=15", "-i", key, `${user}@${host}`, remoteCommand,
]);
console.log(JSON.stringify({ pushed: true, count: publicSnapshot.messages.length, bytes: fs.statSync(publishFile).size, at: new Date().toISOString() }));
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
