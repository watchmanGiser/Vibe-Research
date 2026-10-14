/** Nova 整理队列：内容去重、持久重试、调用账本；不保存凭据或群原文。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function atomicSave(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}
export function contentFingerprint(text, images, scope) {
  const normalized = text.replace(/\[图片消息\]\(mediaId=[^\r\n)]+\)/g, '[图片消息]')
    .replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).filter(line => line.trim()).join('\n').trim();
  return digest(JSON.stringify({ scope, text: normalized, images: [...new Set(images.map(file => digest(fs.readFileSync(file))))].sort() }));
}
export function acquireQueueLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(file, 'a', 0o600);
  fs.fchmodSync(descriptor, 0o600);
  // flock 锁关联继承的同一文件描述，子进程退出后仍由父进程持有。
  const result = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', descriptor] });
  if (result.error || result.status !== 0) {
    fs.closeSync(descriptor);
    if (result.status === 1) return null;
    throw Error('整理队列锁不可用');
  }
  return () => fs.closeSync(descriptor);
}
export function normalizedUsage(value, source = 'codex') {
  const input = value?.input_tokens, output = value?.output_tokens;
  const cached = source === 'responses' ? value?.input_tokens_details?.cached_tokens ?? 0 : value?.cached_input_tokens ?? 0;
  if (![input, output, cached].every(v => Number.isSafeInteger(v) && v >= 0) || cached > input) return null;
  const raw = { input_tokens: input, output_tokens: output };
  if (source === 'responses') raw.input_tokens_details = { cached_tokens: cached };
  else raw.cached_input_tokens = cached;
  return { source, inputTokens: input - cached, outputTokens: output, cachedInputTokens: cached,
    totalTokens: input + output, raw };
}
export class JobStore {
  constructor(file, scopeHash, { maxAttempts = 3, retryDelays = [1800000, 7200000], now = Date.now } = {}) {
    this.file = file; this.scopeHash = scopeHash; this.now = now; this.maxAttempts = maxAttempts; this.retryDelays = retryDelays;
    this.data = { schemaVersion: 1, scopeHash, jobs: {} };
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (this.data.schemaVersion !== 1 || this.data.scopeHash !== scopeHash || !this.data.jobs || Array.isArray(this.data.jobs)) throw Error('整理队列身份或结构无效');
    for (const [id, job] of Object.entries(this.data.jobs)) {
      if (!/^[a-f0-9]{64}$/.test(id) || !['pending', 'running', 'retry_wait', 'done', 'failed'].includes(job.status) ||
        !Number.isSafeInteger(job.attempts) || job.attempts < 0 || (job.repairs != null && (!Number.isSafeInteger(job.repairs) || job.repairs < 0 || job.repairs > 1)) || (job.nextRetryAt != null && !Number.isFinite(job.nextRetryAt))) throw Error('整理队列条目无效');
    }
  }
  save() { atomicSave(this.file, this.data); this.dirty = false; }
  ensure(id) {
    if (!this.data.jobs[id]) { this.data.jobs[id] = { status: 'pending', attempts: 0, repairs: 0, createdAt: this.now() }; this.dirty = true; }
    return this.data.jobs[id];
  }
  recoverInterrupted() {
    // 调用方已持有全队列锁；旧 running 状态只能来自退出或被终止的上一轮。
    for (const [id, job] of Object.entries(this.data.jobs)) if (job.status === 'running') this.fail(id, 'INTERRUPTED');
  }
  due(id) {
    const job = this.ensure(id);
    return job.attempts < this.maxAttempts && (job.status === 'pending' || (job.status === 'retry_wait' && job.nextRetryAt <= this.now()));
  }
  begin(id, { repair = false } = {}) {
    const job = this.ensure(id);
    if (job.attempts >= this.maxAttempts || (!repair && !this.due(id)) || (repair && (job.repairs || 0) >= 1)) return false;
    job.status = 'running'; job.attempts++; job.startedAt = this.now(); job.nextRetryAt = null;
    if (repair) job.repairPending = true;
    this.save(); return true;
  }
  repairCompleted(id) {
    const job = this.ensure(id); job.repairs = 1; job.repairPending = false; this.save();
  }
  complete(id, result, { persist = true } = {}) {
    const job = this.ensure(id);
    if (job.status === 'done' && JSON.stringify(job.result) === JSON.stringify(result)) return;
    Object.assign(job, { status: 'done', result, repairPending: false, finishedAt: this.now(), nextRetryAt: null, lastError: null }); this.dirty = true; if (persist) this.save();
  }
  fail(id, code, permanent = false) {
    const job = this.ensure(id);
    const failed = permanent || job.attempts >= this.maxAttempts;
    Object.assign(job, { status: failed ? 'failed' : 'retry_wait', lastError: code, finishedAt: this.now(),
      nextRetryAt: failed ? null : this.now() + this.retryDelays[Math.min(Math.max(job.attempts - 1, 0), this.retryDelays.length - 1)] });
    this.save();
  }
}
export class UsageLedger {
  constructor(file, scopeHash, { tokenBudget = 2000000, callBudget = 24, now = Date.now } = {}) {
    this.file = file; this.scopeHash = scopeHash; this.tokenBudget = tokenBudget; this.callBudget = callBudget; this.now = now;
    this.calls = new Map();
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let event;
        try { event = JSON.parse(lines[i]); } catch { throw Error('用量账本损坏，需要核对后恢复'); }
        if (event.scopeHash === scopeHash && typeof event.callId === 'string') this.calls.set(event.callId, { ...this.calls.get(event.callId), ...event });
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  append(event) {
    const safe = { ...event, scopeHash: this.scopeHash, at: this.now() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.file, JSON.stringify(safe) + '\n', { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
    this.calls.set(safe.callId, { ...this.calls.get(safe.callId), ...safe });
  }
  day(timestamp) { return new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10); }
  stats() {
    const today = this.day(this.now());
    const calls = [...this.calls.values()].filter(call => this.day(call.startedAt ?? call.at) === today);
    return { date: today, calls: calls.length, knownTokens: calls.reduce((n, call) => n + (call.usage?.totalTokens || 0), 0),
      unknownCalls: calls.filter(call => call.usageStatus !== 'reported').length };
  }
  available() { const stats = this.stats(); return stats.calls < this.callBudget && stats.knownTokens < this.tokenBudget; }
  start(jobId, metadata = {}) {
    if (!this.available()) throw Object.assign(Error('每日整理预算已到上限'), { code: 'DAILY_BUDGET' });
    const callId = randomUUID(); this.append({ event: 'started', callId, jobId, startedAt: this.now(), usageStatus: 'unknown', ...metadata });
    return callId;
  }
}
