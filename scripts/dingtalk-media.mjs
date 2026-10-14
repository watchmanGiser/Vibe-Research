/** 只缓存原文引用的图片；钉钉临时下载地址与凭据不进入公开快照。 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
export const imageFilePattern = /^[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/;
export const imagePublicPath = name => `/dingtalk/media/${name}`;
export function messageImageReferences(text) {
  return [...new Set([...text.matchAll(/\[图片消息\]\(mediaId=([^\r\n)]+)\)/g)].map(match => match[1].trim()))];
}
export function imageExtension(bytes) {
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  throw Error('图片资源不是受支持的位图');
}
const maxImageBytes = 20 * 1024 * 1024;
const storeImage = (directory, bytes) => {
  if (!bytes.length || bytes.length > maxImageBytes) throw Error('图片大小超出范围');
  const name = `${hash(bytes)}.${imageExtension(bytes)}`;
  const file = path.join(directory, name);
  if (fs.existsSync(file)) {
    if (!fs.lstatSync(file).isFile() || hash(fs.readFileSync(file)) !== hash(bytes)) throw Error('图片缓存校验失败');
  } else fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
  return name;
};

export async function cacheMessageImages(raw, env = process.env, options = {}) {
  if (raw.conversationId !== env.DINGTALK_CONVERSATION_ID) throw Error('图片归档会话不匹配');
  const directory = env.DINGTALK_MEDIA_CACHE_DIR || path.join(os.homedir(), '.local/share/vibe-research/dingtalk-media');
  const sources = new Map();
  for (const message of raw.messages.flatMap(item => [item, ...(item.duplicateSources || [])])) for (const reference of messageImageReferences(message.text)) sources.set(reference, message.messageId);
  if (!sources.size) return { directory, images: new Map(), localFiles: new Map(), filenames: [], total: 0, ready: 0, unavailable: 0, downloadFailures: 0 };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const indexFile = path.join(directory, 'index.json');
  const conversationHash = hash(raw.conversationId);
  let files = {};
  if (fs.existsSync(indexFile)) {
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (index.schemaVersion !== 1 || index.conversationHash !== conversationHash || !index.files || typeof index.files !== 'object' || Array.isArray(index.files)) throw Error('图片缓存身份无效');
    files = index.files;
  }
  const cached = reference => {
    const name = files[hash(reference)];
    if (typeof name !== 'string' || !imageFilePattern.test(name)) return false;
    const file = path.join(directory, name);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size > maxImageBytes) return false;
    const bytes = fs.readFileSync(file);
    try { return hash(bytes) === name.split('.')[0] && imageExtension(bytes) === name.split('.').at(-1); } catch { return false; }
  };
  const external = options.download === false ? [] : [...sources.keys()].filter(reference => !cached(reference) && reference.startsWith('https://'));
  let downloadFailures = 0;
  // 当前群的公开图片源。不自动抓取任意消息网址或跟随跳转。
  const fetchExternal = async reference => {
    try {
      const url = new URL(reference);
      if (url.hostname !== 'pic.guhai888.cn' || url.username || url.password || url.port || url.search || url.hash || !/^\/view\.php\/[a-f0-9]{32}\.jpg$/.test(url.pathname)) throw Error('不支持的公开图片来源');
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(20000, (options.deadline || Infinity) - Date.now()))), ...(options.signal ? [options.signal] : [])]), headers: { 'User-Agent': 'VibeResearch-image-cache/1.0' } });
      if (!response.ok || !response.body) throw Error('原图下载失败');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxImageBytes) throw Error('原图过大');
        chunks.push(Buffer.from(chunk));
      }
      files[hash(reference)] = storeImage(directory, Buffer.concat(chunks));
    } catch { downloadFailures++; }
  };
  const expired = () => options.signal?.aborted || (options.deadline != null && Date.now() >= options.deadline);
  for (let offset = 0; offset < external.length && !expired(); offset += 4) await Promise.all(external.slice(offset, offset + 4).map(fetchExternal));
  const opaque = options.download === false ? [] : [...sources.keys()].filter(reference => !cached(reference) && reference.startsWith('@'));
  const messageIds = [...new Set(opaque.map(reference => sources.get(reference)))];
  // 查询与下载同一批真实消息，沿返回的 ledger 接收资源，不拼接媒体地址。
  for (let offset = 0; offset < messageIds.length && !expired(); offset += 50) {
    const stage = fs.mkdtempSync(path.join(directory, '.download-'));
    try {
      const result = spawnSync(env.DWS_BIN || 'dws', ['chat', '+messages-mget', '--msg-ids', messageIds.slice(offset, offset + 50).join(','), '--no-reactions', '--no-threads', '--download-resources', '--output-dir', './resources', '--format', 'json'],
        { cwd: stage, env, encoding: 'utf8', timeout: Math.max(1, Math.min(150000, (options.deadline || Infinity) - Date.now())), maxBuffer: 32 * 1024 * 1024 });
      if (result.error || result.status !== 0) { downloadFailures += messageIds.slice(offset, offset + 50).length; break; }
      const response = JSON.parse(result.stdout);
      if (response.messagesComplete !== true || !Array.isArray(response.messages) || response.messages.some(message => message.conversationId !== raw.conversationId)) { downloadFailures++; break; }
      const validMessageIds = new Set(response.messages.map(message => message.messageId));
      for (const item of response.resourceDownloads?.downloads || []) {
        if (!sources.has(item.resourceId) || !validMessageIds.has(item.messageId) || sources.get(item.resourceId) !== item.messageId || typeof item.localPath !== 'string') continue;
        const file = path.resolve(stage, item.localPath);
        if (!file.startsWith(stage + path.sep) || !fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file || fs.statSync(file).size > maxImageBytes) continue;
        try { files[hash(item.resourceId)] = storeImage(directory, fs.readFileSync(file)); } catch { downloadFailures++; }
      }
    } catch { downloadFailures++; break; }
    finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  const indexTemp = `${indexFile}.${process.pid}.tmp`;
  fs.writeFileSync(indexTemp, JSON.stringify({ schemaVersion: 1, conversationHash, files }) + '\n', { mode: 0o600 });
  fs.renameSync(indexTemp, indexFile);
  const images = new Map([...sources.keys()].filter(cached).map(reference => [reference, imagePublicPath(files[hash(reference)])]));
  const localFiles = new Map([...sources.keys()].filter(cached).map(reference => [reference, path.join(directory, files[hash(reference)])]));
  return { directory, images, localFiles, filenames: [...new Set([...images.values()].map(url => url.split('/').at(-1)))],
    total: sources.size, ready: images.size, unavailable: sources.size - images.size, downloadFailures };
}
