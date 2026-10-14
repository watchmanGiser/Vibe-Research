/** 独立发布调用统计，只公开计数和最近调用状态，不发布模型配置或原文。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { UsageLedger, atomicSave, acquireQueueLock } from './dingtalk-jobs.mjs';
import { windowPaused, pausedResult, updateDeadline, snapshotCommitCommand } from './dingtalk-schedule.mjs';
const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');

export function buildUsageSnapshot(ledger, limit, now = Date.now()) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw Error('调用上限无效');
  const stats = ledger.stats();
  const latest = [...ledger.calls.values()].filter(call => Number.isFinite(call.startedAt)).sort((a, b) => b.startedAt - a.startedAt)[0];
  return { schemaVersion: 1, date: stats.date, limit, used: stats.calls, remaining: Math.max(0, limit - stats.calls),
    latestAt: latest ? new Date(latest.startedAt).toISOString() : null,
    latestStatus: !latest ? null : latest.event !== 'finished' ? 'running' : latest.success === true ? 'success' : latest.errorCode === 'MODEL_TIMEOUT' ? 'timeout' : 'failed',
    updatedAt: new Date(now).toISOString() };
}

function configuredLimit(env) {
  if (env.DINGTALK_DAILY_CALL_BUDGET) return Number(env.DINGTALK_DAILY_CALL_BUDGET);
  const config = execFileSync('systemctl', ['--user', 'show', 'vibe-research-dingtalk-push.service', '-p', 'Environment', '--value'],
    { env, encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const value = config.match(/(?:^|\s|")DINGTALK_DAILY_CALL_BUDGET=(\d+)(?=\s|"|$)/)?.[1];
  if (!value) throw Error('无法读取正在使用的调用上限');
  return Number(value);
}

export async function publishUsage(env = process.env) {
  if (windowPaused(env)) { console.log(JSON.stringify(pausedResult())); return; }
  const deadline = updateDeadline(55000, env);
  const source = env.DINGTALK_LOCAL_SNAPSHOT_FILE || path.join(os.homedir(), '.local/share/vibe-research/dingtalk.json');
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (!env.DINGTALK_CONVERSATION_ID || raw.conversationId !== env.DINGTALK_CONVERSATION_ID) throw Error('用量会话身份不匹配');
  const summary = env.DINGTALK_LOCAL_SUMMARY_FILE || path.join(os.homedir(), '.local/share/vibe-research/jqz-summaries.json');
  const ledgerFile = env.DINGTALK_USAGE_LEDGER_FILE || `${summary}.usage.jsonl`;
  fs.accessSync(ledgerFile, fs.constants.R_OK);
  if (!fs.lstatSync(ledgerFile).isFile()) throw Error('真实调用账本不可用');
  const ledger = new UsageLedger(ledgerFile, hash(raw.conversationId));
  const snapshot = buildUsageSnapshot(ledger, configuredLimit(env));
  if (env.DINGTALK_USAGE_PUBLISH_ONLY === '1') { console.log(JSON.stringify(snapshot)); return snapshot; }
  const host = env.DINGTALK_PUSH_HOST?.trim(), user = env.DINGTALK_PUSH_USER || 'ubuntu', key = env.DINGTALK_PUSH_SSH_KEY;
  const remote = '/opt/vibe-research/shared/semi/dingtalk-usage.json';
  if (!host || !/^[A-Za-z0-9.-]+$/.test(host) || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(user) || !key || !fs.existsSync(key)) throw Error('用量推送配置无效');
  const stateFile = `${summary}.usage-published.json`;
  const release = acquireQueueLock(`${stateFile}.lock`);
  if (!release) return;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-usage-'));
  try {
    const contentHash = hash(JSON.stringify({ ...snapshot, updatedAt: null }));
    const targetHash = hash(JSON.stringify([hash(raw.conversationId), host, user, remote]));
    try {
      const prior = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (prior.contentHash === contentHash && prior.targetHash === targetHash) return;
    } catch { /* 首次统计或日切后重新发布。 */ }
    const file = path.join(stage, 'dingtalk-usage.json'); fs.writeFileSync(file, JSON.stringify(snapshot) + '\n', { mode: 0o600 });
    const upload = `${remote}.uploading-${process.pid}`;
    const args = ['-F', '/dev/null', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-i', key];
    const run = (bin, parameters) => execute(bin, parameters, { env, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 128 * 1024, stdio: ['ignore', 'ignore', 'ignore'] });
    await run('scp', [...args, file, `${user}@${host}:${upload}`]);
    await run('ssh', [...args, `${user}@${host}`, snapshotCommitCommand(upload, remote, env).replace('chmod 0640', 'chmod 0644')]);
    atomicSave(stateFile, { contentHash, targetHash });
    console.log(JSON.stringify({ published: true, date: snapshot.date, used: snapshot.used, remaining: snapshot.remaining }));
    return snapshot;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); release(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await publishUsage();
