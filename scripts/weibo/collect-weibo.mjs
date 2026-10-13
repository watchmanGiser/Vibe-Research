#!/usr/bin/env node
/** 在 Nova 用独立匿名浏览会话采集公开微博，保存原始响应并原子推送。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { UID, normalizePost, buildSnapshot, failureSnapshot } from './weibo-common.mjs';

const STATE = process.env.WEIBO_STATE_DIR || path.join(os.homedir(), '.local/share/vibe-research/weibo');
const FILE = path.join(STATE, 'jianfang.json');
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.new-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function previousSnapshot() {
  if (!fs.existsSync(FILE)) return null;
  const prior = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (prior.uid !== UID || prior.schemaVersion !== 1 || !Array.isArray(prior.items)) throw Error('本地微博快照身份或格式无效');
  return prior;
}
async function collect() {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.WEIBO_BROWSER || '/opt/google/chrome/chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(`https://m.weibo.cn/u/${UID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // 访客页会自动跳转并创建匿名会话，不读取或保存个人浏览器登录资料。
    await page.waitForURL(`https://m.weibo.cn/u/${UID}`, { timeout: 60000 });
    await page.waitForFunction(() => document.body.innerText.includes('交易者简放'), { timeout: 45000 });
    const fetchJson = async url => await page.evaluate(async url => {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw Error('微博公开接口暂不可用');
      const j = await r.json();
      if (j.ok !== 1) throw Error('微博公开接口未返回有效内容');
      return j;
    }, url);
    const timeline = await fetchJson(`/api/container/getIndex?type=uid&value=${UID}&containerid=107603${UID}&page=1`);
    const posts = (timeline.data?.cards || []).flatMap(card => card.mblog ? [card.mblog] : (card.card_group || []).filter(c => c.mblog).map(c => c.mblog));
    if (!posts.length || posts.some(p => String(p.user?.id) !== UID)) throw Error('微博列表为空或账号不匹配');
    const expanded = new Map();
    const longRaw = {};
    const warnings = [];
    const previous = previousSnapshot();
    for (const raw of posts.flatMap(p => [p, p.retweeted_status].filter(Boolean))) {
      if (!raw.isLongText) continue;
      // 重取全文以跟踪编辑；接口失败时由合并逻辑保留已取得的完整正文。
      try {
        const result = await fetchJson(`/statuses/extend?id=${raw.id}`);
        if (!result.data?.longTextContent) throw Error('未取得全文');
        expanded.set(String(raw.id), result.data); longRaw[String(raw.id)] = result;
      } catch { warnings.push(`微博 ${raw.id} 全文暂未更新，保留已有正文或标注节选`); }
    }
    const items = posts.map(p => normalizePost(p, expanded));
    const at = new Date().toISOString();
    atomicJson(path.join(STATE, 'raw', at.slice(0, 10), `${at.replace(/[:.]/g, '-')}.json`), { collectedAt: at, uid: UID, timeline, longTexts: longRaw });
    return buildSnapshot(previous, items, at, warnings);
  } finally { await browser.close(); }
}
function publish(snapshot) {
  const host = process.env.WEIBO_PUSH_HOST || '42.193.184.157';
  const user = process.env.WEIBO_PUSH_USER || 'ubuntu';
  const key = process.env.WEIBO_PUSH_SSH_KEY;
  const remote = '/opt/vibe-research/shared/weibo/jianfang.json';
  if (!/^[A-Za-z0-9.-]+$/.test(host) || !/^[a-z_][a-z0-9_-]*$/.test(user) || !key || !fs.existsSync(key)) throw Error('微博推送配置无效');
  const ssh = ['-F', '/dev/null', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', key];
  const dest = `${user}@${host}`;
  const uploading = `${remote}.uploading-${process.pid}`;
  const run = (bin, args) => { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
    if (r.error || r.status !== 0) throw Error('微博快照推送失败，线上保留原有内容'); };
  run('scp', [...ssh, '-q', FILE, `${dest}:${uploading}`]);
  run('ssh', [...ssh, dest, `chmod 640 ${uploading} && mv -f ${uploading} ${remote}`]);
  atomicJson(path.join(STATE, 'last-publish.json'), { publishedAt: new Date().toISOString(), syncedAt: snapshot.syncedAt, count: snapshot.items.length, status: snapshot.status });
}
export async function syncOnce() {
  let snapshot;
  let failed = false;
  try { snapshot = await collect(); }
  catch {
    failed = true;
    snapshot = failureSnapshot(previousSnapshot(), new Date().toISOString());
    if (!snapshot) throw Error('微博首次采集失败，尚无可推送内容');
  }
  atomicJson(FILE, snapshot);
  if (!process.argv.includes('--collect-only')) publish(snapshot);
  console.log(JSON.stringify({ uid: UID, count: snapshot.items.length, syncedAt: snapshot.syncedAt, status: snapshot.status }));
  if (failed) process.exitCode = 1;
  return snapshot;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncOnce().catch(() => { console.error('微博采集或推送未完成，保留已有内容，请检查服务状态'); process.exitCode = 1; });
}
