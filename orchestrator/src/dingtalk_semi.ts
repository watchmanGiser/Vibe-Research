/** 线上仅读取 Nova 推送的去重快照，不连接钉钉或加载 DWS 凭据。 */
import fs from "node:fs";
import { createHash } from "node:crypto";

export type DingTalkGroupMessage = {
  messageId: string;
  time: string;
  sender: string;
  text: string;
  duplicateCount: number;
};

type DingTalkGroupFeed = {
  group: string;
  syncedAt: string;
  receivedCount: number;
  duplicateCount: number;
  messages: DingTalkGroupMessage[];
};

export class DingTalkSnapshotError extends Error {
  readonly status = 503;
}

export function fetchDingTalkGroup(limit = 200): DingTalkGroupFeed {
  const file = process.env.DINGTALK_SEMI_SNAPSHOT_FILE?.trim() || "/opt/vibe-research/shared/semi/dingtalk.json";
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // 不把服务器绝对路径、文件内容或系统错误详情暴露给浏览器。
    throw new DingTalkSnapshotError("钉钉群消息快照暂不可用");
  }
  if (!value || typeof value !== "object") throw new DingTalkSnapshotError("钉钉群消息快照格式无效");
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.group !== "string" || !snapshot.group ||
      typeof snapshot.syncedAt !== "string" || !Number.isFinite(Date.parse(snapshot.syncedAt)) ||
      typeof snapshot.receivedCount !== "number" || !Number.isInteger(snapshot.receivedCount) || snapshot.receivedCount < 0 ||
      typeof snapshot.duplicateCount !== "number" || !Number.isInteger(snapshot.duplicateCount) || snapshot.duplicateCount < 0 ||
      !Array.isArray(snapshot.messages)) throw new DingTalkSnapshotError("钉钉群消息快照格式无效");

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 200;
  const messages = snapshot.messages.slice(0, safeLimit).map((item: unknown) => {
    if (!item || typeof item !== "object") throw new DingTalkSnapshotError("钉钉群消息快照格式无效");
    const m = item as Record<string, unknown>;
    if (typeof m.messageId !== "string" || !m.messageId ||
        typeof m.time !== "string" || typeof m.sender !== "string" || typeof m.text !== "string" ||
        typeof m.duplicateCount !== "number" || !Number.isInteger(m.duplicateCount) || m.duplicateCount < 0) {
      throw new DingTalkSnapshotError("钉钉群消息快照格式无效");
    }
    // 只返回展示字段，内部会话 ID、重复消息 ID、原始响应都留在本地/快照里。
    return { messageId: createHash("sha256").update(m.messageId).digest("hex"), time: m.time, sender: m.sender, text: m.text, duplicateCount: m.duplicateCount };
  });
  return {
    group: snapshot.group, syncedAt: snapshot.syncedAt,
    receivedCount: snapshot.receivedCount, duplicateCount: snapshot.duplicateCount, messages,
  };
}
