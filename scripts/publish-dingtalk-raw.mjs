#!/usr/bin/env node
/** 将完整去重原文与配图推送到独立快照，不依赖模型整理。 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheMessageImages, messageImageReferences } from './dingtalk-media.mjs';
import { mergeMessageHistory, normalizedMessageText, validateArchivedMessage } from './dingtalk-duplicates.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
export { normalizedMessageText };
const validText = (s) => typeof s === 'string' && s.trim().length > 0;
const timestamp = (s) => Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + '+08:00' : s);

export function buildRawFeed(raw, expectedConversationId, images = new Map()) {
  if (!raw || raw.conversationId !== expectedConversationId || !validText(expectedConversationId) || !Array.isArray(raw.messages) ||
      !validText(raw.syncedAt) || !Number.isFinite(timestamp(raw.syncedAt)) || !Number.isInteger(raw.duplicateCount) || raw.duplicateCount < 0) {
    throw Error('本地原文快照身份或格式无效，保留线上快照');
  }
  for (const message of raw.messages) validateArchivedMessage(message);
  const history = mergeMessageHistory(raw.messages);
  const sourceImages = text => messageImageReferences(text).filter(reference => images.has(reference)).map(reference => ({ reference, url: images.get(reference) }));
  const messages = history.messages.map(message => {
    const id = hash(message.messageId);
    const relatedIds = [...new Set([id, ...(message.duplicateMessageIds || []).map(hash), ...(message.duplicateSources || []).map(source => hash(source.messageId))])];
    const attached = sourceImages(message.text);
    const versions = (message.duplicateSources || []).map(source => ({ id: hash(source.messageId), time: source.time, sender: source.sender, text: source.text,
      ...(sourceImages(source.text).length ? { images: sourceImages(source.text) } : {}) }));
    return { id, time: message.time, sender: message.sender, text: message.text, duplicateCount: message.duplicateCount,
      relatedIds, latestDuplicateTime: message.latestDuplicateTime || null,
      ...(attached.length ? { images: attached } : {}), ...(versions.length ? { versions } : {}) };
  });
  const duplicateCount = Math.max(raw.duplicateCount, history.duplicateCount);
  return { schemaVersion: 1, label: '击球区原始消息', syncedAt: raw.syncedAt, duplicateCount, messages };
}

export async function publishRawFeed(env = process.env) {
  const source = env.DINGTALK_LOCAL_SNAPSHOT_FILE || env.DINGTALK_SEMI_SNAPSHOT_FILE || path.join(os.homedir(), '.local/share/vibe-research/dingtalk.json');
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  let feed = buildRawFeed(raw, env.DINGTALK_CONVERSATION_ID);
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
  const media = await cacheMessageImages(raw, env);
  feed = buildRawFeed(raw, env.DINGTALK_CONVERSATION_ID, media.images);
  const stateFile = `${source}.published-content.json`;
  const targetHash = hash(JSON.stringify([env.DINGTALK_CONVERSATION_ID, host, user, remote]));
  const contentHash = hash(JSON.stringify(feed.messages.map(({ id, time, sender, text, images, versions }) => ({ id, time, sender, text, images, versionImages: [...new Set((versions || []).flatMap(version => (version.images || []).map(image => image.url)))].sort() }))));
  try {
    const previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (previous.contentHash === contentHash && previous.targetHash === targetHash) {
      console.log(JSON.stringify({ skipped: true, reason: 'no-new-content', messages: feed.messages.length }));return;
    }
  } catch { /* 首次发布或旧状态无效时重新校验上传。 */ }
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
    if (media.filenames.length) {
      const localMedia = path.join(stage, 'images');
      fs.mkdirSync(localMedia, { mode: 0o700 });
      for (const name of media.filenames) fs.copyFileSync(path.join(media.directory, name), path.join(localMedia, name));
      const remoteMedia = path.posix.join(path.posix.dirname(remote), 'dingtalk-media');
      const upload = `${remoteMedia}.uploading-${process.pid}-${Date.now()}`;
      run('scp', [...sshArgs, '-r', localMedia, `${user}@${host}:${upload}`]);
      run('ssh', [...sshArgs, `${user}@${host}`, `set -e; mkdir -p -- '${remoteMedia}'; chmod 0755 '${remoteMedia}'; for f in '${upload}'/*; do chmod 0644 "$f"; mv -f -- "$f" '${remoteMedia}/'; done; rmdir -- '${upload}'`]);
    }
    run('scp', [...sshArgs, file, `${user}@${host}:${dest}`]);
    run('ssh', [...sshArgs, `${user}@${host}`, `test -s '${dest}' && chmod 0640 '${dest}' && mv -f -- '${dest}' '${remote}'`]);
    const stateTemp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(stateTemp, JSON.stringify({ contentHash, targetHash }) + '\n', { mode: 0o600 });
    fs.renameSync(stateTemp, stateFile);
    console.log(JSON.stringify({ pushed: true, messages: feed.messages.length, duplicateCount: feed.duplicateCount, syncedAt: feed.syncedAt, images: media.ready, unavailableImages: media.unavailable }));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await publishRawFeed();
