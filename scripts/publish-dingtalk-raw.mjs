#!/usr/bin/env node
/** 将完整去重原文与配图推送到独立快照，不依赖模型整理。 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const executeFile = promisify(execFile);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheMessageImages, messageImageReferences } from './dingtalk-media.mjs';
import { cacheMessageDocuments, messageDocumentReferences } from './dingtalk-documents.mjs';
import { windowPaused, pausedResult, assertUpdateWindow, updateDeadline, snapshotCommitCommand, mediaCommitCommand } from './dingtalk-schedule.mjs';
import { mergeMessageHistory, normalizedMessageText, validateArchivedMessage } from './dingtalk-duplicates.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
export { normalizedMessageText };
const validText = (s) => typeof s === 'string' && s.trim().length > 0;
const timestamp = (s) => Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + '+08:00' : s);

export function buildRawFeed(raw, expectedConversationId, images = new Map(), documents = new Map()) {
  if (!raw || raw.conversationId !== expectedConversationId || !validText(expectedConversationId) || !Array.isArray(raw.messages) ||
      !validText(raw.syncedAt) || !Number.isFinite(timestamp(raw.syncedAt)) || !Number.isInteger(raw.duplicateCount) || raw.duplicateCount < 0) {
    throw Error('本地原文快照身份或格式无效，保留线上快照');
  }
  for (const message of raw.messages) validateArchivedMessage(message);
  const history = mergeMessageHistory(raw.messages);
  const sourceImages = text => messageImageReferences(text).filter(reference => images.has(reference)).map(reference => ({ reference, url: images.get(reference) }));
  const sourceDocuments = text => messageDocumentReferences(text).map(reference => documents.get(reference.id)).filter(Boolean);
  const messages = history.messages.map(message => {
    const id = hash(message.messageId);
    const relatedIds = [...new Set([id, ...(message.duplicateMessageIds || []).map(hash), ...(message.duplicateSources || []).map(source => hash(source.messageId))])];
    const attached = sourceImages(message.text);
    const versions = (message.duplicateSources || []).map(source => ({ id: hash(source.messageId), time: source.time, sender: source.sender, text: source.text,
      ...(sourceImages(source.text).length ? { images: sourceImages(source.text) } : {}),
      ...(sourceDocuments(source.text).length ? { documents: sourceDocuments(source.text) } : {}) }));
    return { id, time: message.time, sender: message.sender, text: message.text, duplicateCount: message.duplicateCount,
      relatedIds, latestDuplicateTime: message.latestDuplicateTime || null,
      ...(attached.length ? { images: attached } : {}), ...(versions.length ? { versions } : {}),
      ...(sourceDocuments(message.text).length ? { documents: sourceDocuments(message.text) } : {}) };
  });
  const duplicateCount = Math.max(raw.duplicateCount, history.duplicateCount);
  return { schemaVersion: 1, label: '击球区原始消息', syncedAt: raw.syncedAt, duplicateCount, messages };
}

export async function publishRawFeed(env = process.env) {
  if (windowPaused(env)) { console.log(JSON.stringify(pausedResult())); return; }
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
  const media = await cacheMessageImages(raw, env, { deadline: updateDeadline(Infinity, env) });
  const documents = await cacheMessageDocuments(raw, env, { deadline: updateDeadline(240000, env) });
  feed = buildRawFeed(raw, env.DINGTALK_CONVERSATION_ID, media.images, documents.documents);
  const stateFile = `${source}.published-content.json`;
  const targetHash = hash(JSON.stringify([env.DINGTALK_CONVERSATION_ID, host, user, remote]));
  const contentHash = hash(JSON.stringify({ documentPublicationHash: documents.publicationHash, messages: feed.messages.map(({ id, time, sender, text, images, documents, versions }) => ({ id, time, sender, text, images, documents, versionImages: [...new Set((versions || []).flatMap(version => (version.images || []).map(image => image.url)))].sort(), versionDocuments: (versions || []).flatMap(version => version.documents || []) })) }));
  try {
    const previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (previous.contentHash === contentHash && previous.targetHash === targetHash) {
      console.log(JSON.stringify({ skipped: true, reason: 'no-new-content', messages: feed.messages.length }));return;
    }
  } catch { /* 首次发布或旧状态无效时重新校验上传。 */ }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-raw-publish-'));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort); process.once('SIGINT', abort);
  const run = async (bin, args) => {
    assertUpdateWindow(env);
    try {
      await executeFile(bin, args, { encoding: 'utf8', timeout: Math.max(1, updateDeadline(120000, env) - Date.now()), maxBuffer: 1024 * 1024, env, signal: controller.signal });
    } catch { throw Error(`原文${bin === 'scp' ? '上传' : '发布'}失败，保留线上快照`); }
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
      await run('scp', [...sshArgs, '-r', localMedia, `${user}@${host}:${upload}`]);
      await run('ssh', [...sshArgs, `${user}@${host}`, mediaCommitCommand(upload, remoteMedia, env)]);
    }
    if (documents.filenames.length) {
      const localDocuments = path.join(stage, 'dingtalk-documents'); fs.mkdirSync(localDocuments, { mode: 0o700 });
      for (const name of documents.filenames) fs.copyFileSync(path.join(documents.directory, name), path.join(localDocuments, name));
      const remoteDocuments = path.posix.join(path.posix.dirname(remote), 'dingtalk-documents');
      const upload = `${remoteDocuments}.uploading-${process.pid}-${Date.now()}`;
      await run('scp', [...sshArgs, '-r', localDocuments, `${user}@${host}:${upload}`]);
      await run('ssh', [...sshArgs, `${user}@${host}`, mediaCommitCommand(upload, remoteDocuments, env)]);
    }
    await run('scp', [...sshArgs, file, `${user}@${host}:${dest}`]);
    await run('ssh', [...sshArgs, `${user}@${host}`, snapshotCommitCommand(dest, remote, env)]);
    const stateTemp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(stateTemp, JSON.stringify({ contentHash, targetHash }) + '\n', { mode: 0o600 });
    fs.renameSync(stateTemp, stateFile);
    console.log(JSON.stringify({ pushed: true, messages: feed.messages.length, duplicateCount: feed.duplicateCount, syncedAt: feed.syncedAt, images: media.ready, unavailableImages: media.unavailable, documents: documents.ready, unavailableDocuments: documents.unavailable }));
  } finally {
    process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await publishRawFeed();
