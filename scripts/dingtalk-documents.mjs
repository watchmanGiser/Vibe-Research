/** 文档按来源下载、校验、缓存和解析，原文发布与模型整理共享结果。 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireQueueLock, atomicSave } from './dingtalk-jobs.mjs';

const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
export const documentFilePattern = /^[a-f0-9]{64}(?:-[a-f0-9]{64})?(?:-preview|-page-\d{3})?\.(?:pdf|docx|doc|txt|jpg)$/;
const publicPath = name => `/dingtalk/documents/${name}`;
const maxBytes = 40 * 1024 * 1024;
const defaultHosts = ['pushmedia.oss-cn-beijing.aliyuncs.com'];

export function messageDocumentReferences(text) {
  const result = new Map();
  const add = (reference, label = '') => {
    try {
      const url = new URL(reference);
      const filename = label || decodeURIComponent(url.pathname.split('/').at(-1) || '');
      const kind = filename.match(/\.(pdf|docx|doc)$/i)?.[1]?.toLowerCase();
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !kind) return;
      const name = filename.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 240);
      result.set(reference, { id: hash(reference), reference, name, kind });
    } catch { /* 非文档或无效网址继续保留在消息正文。 */ }
  };
  for (const match of text.matchAll(/\[([^\]\r\n]+)\]\((https:\/\/[^\s<>]+?)\)/g)) add(match[2], match[1]);
  for (const match of text.matchAll(/https:\/\/[^\s<>\[\]]+/g)) {
    const reference = match[0].replace(/[)）。，；,;]+$/, '');
    if (!result.has(reference)) add(reference);
  }
  return [...result.values()];
}

function availableFile(directory, name, maximum = maxBytes * 3) {
  if (typeof name !== 'string' || !documentFilePattern.test(name)) return false;
  const file = path.join(directory, name);
  return fs.existsSync(file) && fs.lstatSync(file).isFile() && fs.statSync(file).size <= maximum;
}
function validArtifacts(directory, entry, verifyHashes = true) {
  const fingerprint = typeof entry?.file === 'string' ? entry.file.split('.')[0] : '';
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || !availableFile(directory, entry.file) ||
      hash(fs.readFileSync(path.join(directory, entry.file))) !== fingerprint ||
      !availableFile(directory, entry.textFile) || !new RegExp(`^${fingerprint}(?:-[a-f0-9]{64})?\\.txt$`).test(entry.textFile) ||
      !Number.isSafeInteger(entry.textChars) || entry.textChars > 2000000 ||
      !(entry.pageCount === null || Number.isSafeInteger(entry.pageCount) && entry.pageCount > 0 && entry.pageCount <= 200) ||
      !Array.isArray(entry.pageImages) || entry.pageImages.length > 100 ||
      !entry.pageImages.every(name => typeof name === 'string' && new RegExp(`^${fingerprint}(?:-[a-f0-9]{64})?-page-\\d{3}\\.jpg$`).test(name) && availableFile(directory, name)) ||
      (entry.previewFile && !(entry.previewFile === entry.file && entry.file.endsWith('.pdf') ||
        new RegExp(`^${fingerprint}(?:-[a-f0-9]{64})?-preview\\.pdf$`).test(entry.previewFile) && availableFile(directory, entry.previewFile)))) return false;
  const text = fs.readFileSync(path.join(directory, entry.textFile), 'utf8');
  if (text.length !== entry.textChars || !(entry.status === 'partial' ? text.trim().length > 0 : text.trim().length >= 40)) return false;
  const missing = entry.unreadablePages || [];
  if (!Array.isArray(missing) || missing.some(page => !Number.isSafeInteger(page) || page < 1 || page > entry.pageCount) ||
      (entry.status === 'partial' ? missing.length === 0 : missing.length > 0)) return false;
  if (!verifyHashes) return true;
  if (!entry.artifactHashes || typeof entry.artifactHashes !== 'object' || Array.isArray(entry.artifactHashes)) return false;
  return [entry.textFile, entry.previewFile, ...entry.pageImages].filter(name => name && name !== entry.file).every(name => {
    const digest = hash(fs.readFileSync(path.join(directory, name)));
    return entry.artifactHashes[name] === digest && name.startsWith(fingerprint + '-' + digest);
  });
}
const ready = (directory, entry) => entry?.status === 'ready' && validArtifacts(directory, entry);

function commitArtifacts(directory, stage, entry, parsed) {
  const fingerprint = entry.file.split('.')[0];
  const result = { ...parsed, artifactHashes: {} };
  for (const name of [...new Set([parsed.textFile, parsed.previewFile, ...parsed.pageImages].filter(name => name && name !== entry.file))]) {
    const bytes = fs.readFileSync(path.join(stage, name));
    const digest = hash(bytes);
    const version = fingerprint + '-' + digest + name.slice(fingerprint.length);
    fs.renameSync(path.join(stage, name), path.join(directory, version));
    result.artifactHashes[version] = digest;
    if (parsed.textFile === name) result.textFile = version;
    if (parsed.previewFile === name) result.previewFile = version;
    result.pageImages = result.pageImages.map(image => image === name ? version : image);
  }
  return result;
}
function documentType(bytes, kind) {
  if (kind === 'pdf') return bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'));
  if (kind === 'docx') return bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'));
  return bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
}

export async function cacheMessageDocuments(raw, env = process.env, options = {}) {
  if (raw.conversationId !== env.DINGTALK_CONVERSATION_ID) throw Error('文档归档会话不匹配');
  const directory = env.DINGTALK_DOCUMENT_CACHE_DIR || path.join(os.homedir(), '.local/share/vibe-research/dingtalk-documents');
  const references = new Map();
  for (const message of raw.messages.flatMap(item => [item, ...(item.duplicateSources || [])])) {
    for (const reference of messageDocumentReferences(message.text)) references.set(reference.id, reference);
  }
  if (!references.size) return { directory, documents: new Map(), texts: new Map(), fingerprints: new Map(), filenames: [], ready: 0, unavailable: 0, publicationHash: hash('[]') };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = options.download === false ? () => {} : acquireQueueLock(path.join(directory, '.lock'));
  if (!release) return cacheMessageDocuments(raw, env, { ...options, download: false });
  try {
    const indexFile = path.join(directory, 'index.json');
    let index = { schemaVersion: 1, conversationHash: hash(raw.conversationId), entries: {} };
    if (fs.existsSync(indexFile)) {
      index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      if (index.schemaVersion !== 1 || index.conversationHash !== hash(raw.conversationId) || !index.entries || typeof index.entries !== 'object' || Array.isArray(index.entries)) throw Error('文档缓存身份无效');
    }
    const hosts = new Set((env.DINGTALK_DOCUMENT_ALLOWED_HOSTS || defaultHosts.join(',')).split(',').map(value => value.trim()).filter(Boolean));
    const limit = Number(env.DINGTALK_MAX_DOCUMENTS_PER_RUN || 4);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw Error('文档处理上限无效');
    const expired = () => options.signal?.aborted || (options.deadline != null && Date.now() >= options.deadline);
    const save = () => { if (options.download !== false) atomicSave(indexFile, index); };
    let processed = 0;
    for (const reference of references.values()) {
      let entry = index.entries[reference.id];
      if (ready(directory, entry)) continue;
      if (!hosts.has(new URL(reference.reference).hostname)) {
        index.entries[reference.id] = { status: 'unsupported', error: 'SOURCE_UNSUPPORTED' }; continue;
      }
      // 已成功的旧缓存升级格式不消耗原有失败额度，只迁移一次。
      if (options.download !== false && entry?.status === 'ready' && !Object.hasOwn(entry, 'artifactHashes') &&
          availableFile(directory, entry.file) && hash(fs.readFileSync(path.join(directory, entry.file))) === entry.file.split('.')[0]) {
        entry = { ...entry, status: 'pending', attempts: 0, nextRetryAt: 0 };
        index.entries[reference.id] = entry; save();
      }
      if (options.download === false || expired() || processed >= limit || entry?.attempts >= 3 || (entry?.nextRetryAt || 0) > Date.now()) continue;
      processed++;
      entry = { ...entry, status: 'pending', attempts: (entry?.attempts || 0) + 1 };
      index.entries[reference.id] = entry;
      save();
      try {
        if (!availableFile(directory, entry.file) || hash(fs.readFileSync(path.join(directory, entry.file))) !== entry.file.split('.')[0]) {
          const url = new URL(reference.reference);
          if (url.hash) throw Error('SOURCE_INVALID');
          const response = await (options.fetch || fetch)(url, { redirect: 'error',
            signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(30000, (options.deadline || Infinity) - Date.now()))), ...(options.signal ? [options.signal] : [])]),
            headers: { 'User-Agent': 'VibeResearch-document-cache/1.0' } });
          if (!response.ok || !response.body) throw Error('DOCUMENT_DOWNLOAD_FAILED');
          if (Number(response.headers.get('content-length')) > maxBytes) throw Error('DOCUMENT_SIZE_LIMIT');
          const chunks = []; let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > maxBytes) throw Error('DOCUMENT_SIZE_LIMIT');
            chunks.push(Buffer.from(chunk));
          }
          const bytes = Buffer.concat(chunks);
          if (!bytes.length || !documentType(bytes, reference.kind)) throw Error('DOCUMENT_FORMAT_INVALID');
          entry.file = `${hash(bytes)}.${reference.kind}`;
          const destination = path.join(directory, entry.file);
          if (fs.existsSync(destination) && !availableFile(directory, entry.file)) throw Error('CACHE_FILE_INVALID');
          const temporary = destination + `.downloading-${process.pid}`;
          fs.writeFileSync(temporary, bytes, { mode: 0o600 });
          fs.renameSync(temporary, destination);
          save();
        }
        if (expired()) throw Error('DOCUMENT_INTERRUPTED');
        const stage = fs.mkdtempSync(path.join(directory, '.parse-'));
        try {
          const stagedSource = path.join(stage, entry.file);
          fs.copyFileSync(path.join(directory, entry.file), stagedSource);
          const parsed = options.parse ? await options.parse(stagedSource, stage) :
            JSON.parse((await execute(env.DINGTALK_DOCUMENT_PYTHON || 'python3', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'parse-dingtalk-document.py'), stagedSource, stage],
              { encoding: 'utf8', timeout: Math.max(1, Math.min(150000, (options.deadline || Infinity) - Date.now())), maxBuffer: 128 * 1024, signal: options.signal })).stdout.trim());
          if (!parsed || parsed.error || !availableFile(stage, parsed.textFile)) throw Error('DOCUMENT_PARSE_FAILED');
          parsed.textChars = fs.readFileSync(path.join(stage, parsed.textFile), 'utf8').length;
          parsed.unreadablePages ||= [];
          const status = parsed.unreadablePages.length ? 'partial' : 'ready';
          if (!validArtifacts(stage, { ...entry, ...parsed, status }, false)) throw Error('DOCUMENT_PARSE_FAILED');
          const committed = commitArtifacts(directory, stage, entry, parsed);
          Object.assign(entry, committed, { status, nextRetryAt: status === 'partial' ? Date.now() + 30 * 60 * 1000 : 0,
            error: status === 'partial' ? 'DOCUMENT_OCR_PARTIAL' : null, ...(status === 'ready' ? { attempts: 0 } : {}) });
        } finally { fs.rmSync(stage, { recursive: true, force: true }); }
      } catch (error) {
        entry.status = availableFile(directory, entry.file) ? 'parse_failed' : 'download_failed';
        entry.error = /^[A-Z_]+$/.test(error.message) ? error.message : 'DOCUMENT_PROCESS_FAILED';
        entry.nextRetryAt = Date.now() + (entry.attempts === 1 ? 30 : 120) * 60 * 1000;
      }
      save();
    }
    save();
    const documents = new Map(), texts = new Map(), fingerprints = new Map(), filenames = new Set();
    for (const reference of references.values()) {
      const entry = index.entries[reference.id] || { status: 'pending' };
      const previewReady = ['ready', 'partial'].includes(entry.status) && validArtifacts(directory, entry);
      const success = previewReady && entry.status === 'ready';
      const downloadable = availableFile(directory, entry.file) && hash(fs.readFileSync(path.join(directory, entry.file))) === entry.file.split('.')[0];
      if (entry.status === 'pending' && entry.attempts >= 3) entry.status = downloadable ? 'parse_failed' : 'download_failed';
      const document = { id: reference.id, name: reference.name, kind: reference.kind, status: previewReady ? entry.status : ['ready', 'partial'].includes(entry.status) ? 'parse_failed' : entry.status,
        ...(downloadable ? { url: publicPath(entry.file) } : {}),
        ...(previewReady ? { textUrl: publicPath(entry.textFile), pageCount: entry.pageCount, previewImages: entry.pageImages.map(publicPath),
          ...(entry.previewFile ? { previewUrl: publicPath(entry.previewFile) } : {}), ...(entry.status === 'partial' ? { unreadablePages: entry.unreadablePages } : {}) } : {}) };
      documents.set(reference.id, document);
      if (downloadable) filenames.add(entry.file);
      if (previewReady) {
        const text = fs.readFileSync(path.join(directory, entry.textFile), 'utf8');
        if (success) {
          texts.set(reference.id, text);
          fingerprints.set(reference.id, hash(JSON.stringify([entry.file, hash(text)])));
        }
        [entry.textFile, entry.previewFile, ...entry.pageImages].filter(Boolean).forEach(name => filenames.add(name));
      }
    }
    return { directory, documents, texts, fingerprints, filenames: [...filenames], ready: texts.size, unavailable: references.size - texts.size,
      publicationHash: hash(JSON.stringify([[...documents.values()].sort((a, b) => a.id.localeCompare(b.id)), [...fingerprints].sort(),
        [...filenames].sort().map(name => [name, hash(fs.readFileSync(path.join(directory, name)))])])) };
  } finally { release(); }
}
