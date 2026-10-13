#!/usr/bin/env node
/** 将完整去重原文推送到受鉴权保护的独立快照，不依赖模型整理。 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = (s) => createHash('sha256').update(s).digest('hex');
export const normalizedMessageText = (s) => s.normalize('NFC').replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trim();
const validText = (s) => typeof s === 'string' && s.trim().length > 0;
const timestamp = (s) => Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + '+08:00' : s);

export function buildRawFeed(raw, expectedConversationId) {
  if (!raw || raw.conversationId !== expectedConversationId || !validText(expectedConversationId) || !Array.isArray(raw.messages) ||
      !validText(raw.syncedAt) || !Number.isFinite(timestamp(raw.syncedAt)) || !Number.isInteger(raw.duplicateCount) || raw.duplicateCount < 0) {
    throw Error('本地原文快照身份或格式无效，保留线上快照');
  }
  const byText = new Map();
  const seenIds = new Set();
  let merged = 0;
  for (const m of raw.messages) {
    if (!m || !validText(m.messageId) || !validText(m.text) || !validText(m.time) || !Number.isFinite(timestamp(m.time)) ||
        !validText(m.sender) || !Number.isInteger(m.duplicateCount) || m.duplicateCount < 0 ||
        (m.duplicateMessageIds !== undefined && (!Array.isArray(m.duplicateMessageIds) || !m.duplicateMessageIds.every(validText))) ||
        (m.latestDuplicateTime !== undefined && (!validText(m.latestDuplicateTime) || !Number.isFinite(timestamp(m.latestDuplicateTime))))) {
      throw Error('本地原文消息格式无效，保留线上快照');
    }
    const id = hash(m.messageId);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const relatedIds = [...new Set([id, ...(m.duplicateMessageIds || []).map(hash)])];
    const key = hash(normalizedMessageText(m.text));
    const existing = byText.get(key);
    if (existing) {
      existing.duplicateCount += 1 + m.duplicateCount;
      existing.relatedIds = [...new Set([...existing.relatedIds, ...relatedIds])];
      for (const time of [m.time, m.latestDuplicateTime].filter(Boolean)) {
        if (timestamp(time) > timestamp(existing.latestDuplicateTime || existing.time)) existing.latestDuplicateTime = time;
      }
      merged++;
    } else {
      byText.set(key, { id, time: m.time, sender: m.sender, text: m.text, duplicateCount: m.duplicateCount,
        relatedIds, latestDuplicateTime: m.latestDuplicateTime || null });
    }
  }
  const messages = [...byText.values()].sort((a, b) => timestamp(b.time) - timestamp(a.time) || a.id.localeCompare(b.id));
  const duplicateCount = Math.max(raw.duplicateCount + merged, messages.reduce((sum, m) => sum + m.duplicateCount, 0));
  return { schemaVersion: 1, label: '击球区原始消息', syncedAt: raw.syncedAt, duplicateCount, messages };
}

export function publishRawFeed(env = process.env) {
  const source = env.DINGTALK_LOCAL_SNAPSHOT_FILE || env.DINGTALK_SEMI_SNAPSHOT_FILE || path.join(os.homedir(), '.local/share/vibe-research/dingtalk.json');
  const feed = buildRawFeed(JSON.parse(fs.readFileSync(source, 'utf8')), env.DINGTALK_CONVERSATION_ID);
  if (env.DINGTALK_RAW_PUBLISH_ONLY === '1') {
    console.log(JSON.stringify({ validated: true, count: feed.messages.length, duplicateCount: feed.duplicateCount }));
    return;
  }
  const host = env.DINGTALK_PUSH_HOST?.trim();
  const user = env.DINGTALK_PUSH_USER || 'ubuntu';
  const key = env.DINGTALK_PUSH_SSH_KEY?.trim();
  const remote = env.DINGTALK_REMOTE_RAW_SNAPSHOT_FILE || '/opt/vibe-research/shared/semi/dingtalk-raw.json';
  if (!host || !/^[A-Za-z0-9.-]+$/.test(host) || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(user) || !key || !fs.existsSync(key)) throw Error('原文推送配置无效');
  if (!/^\/opt\/vibe-research\/shared\/semi\/[A-Za-z0-9._-]+$/.test(remote) || remote === (env.DINGTALK_REMOTE_SNAPSHOT_FILE || '/opt/vibe-research/shared/semi/dingtalk.json')) throw Error('原文与摘要必须使用独立快照');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-raw-publish-'));
  const run = (bin, args) => {
    const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, env });
    if (result.error || result.status !== 0) throw Error(`原文${bin === 'scp' ? '上传' : '发布'}失败，保留线上快照`);
  };
  try {
    fs.chmodSync(stage, 0o700);
    const file = path.join(stage, 'dingtalk-raw.json');
    fs.writeFileSync(file, JSON.stringify(feed) + '\n', { mode: 0o600 });
    const dest = `${remote}.uploading-${process.pid}-${Date.now()}`;
    const sshArgs = ['-F', '/dev/null', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-i', key];
    run('scp', [...sshArgs, file, `${user}@${host}:${dest}`]);
    run('ssh', [...sshArgs, `${user}@${host}`, `test -s '${dest}' && chmod 0640 '${dest}' && mv -f -- '${dest}' '${remote}'`]);
    console.log(JSON.stringify({ pushed: true, messages: feed.messages.length, duplicateCount: feed.duplicateCount, syncedAt: feed.syncedAt }));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) publishRawFeed();
