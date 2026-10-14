/** 北京时间 01:00（含）至 08:00（不含）停止自动更新，不依赖机器时区。 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const offset = 8 * 3600000;
export function updatesAllowed(now = Date.now()) {
  if (!Number.isFinite(now)) throw Error('更新时间无效');
  const hour = new Date(now + offset).getUTCHours();
  return Number.isFinite(hour) && (hour === 0 || hour >= 8);
}
export function windowPaused(env = process.env, now = Date.now()) {
  return env.DINGTALK_ENFORCE_UPDATE_WINDOW === '1' && !updatesAllowed(now);
}
export function assertUpdateWindow(env = process.env, now = Date.now()) {
  if (windowPaused(env, now)) throw Object.assign(Error('北京时间01:00–08:00暂停更新'), { code: 'QUIET_HOURS' });
}
export function updateDeadline(maximum = Infinity, env = process.env, now = Date.now()) {
  if (env.DINGTALK_ENFORCE_UPDATE_WINDOW !== '1') return now + maximum;
  if (!updatesAllowed(now)) return now;
  const shifted = new Date(now + offset);
  const tomorrow = shifted.getUTCHours() >= 8 ? 1 : 0;
  const close = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + tomorrow, 1) - offset;
  return Math.min(now + maximum, close);
}
export function remoteUpdateGuard(env = process.env) {
  return env.DINGTALK_ENFORCE_UPDATE_WINDOW === '1'
    ? 'dingtalk_update_hour=$(TZ=Asia/Shanghai date +%H) || exit 77; case "$dingtalk_update_hour" in 00|08|09|1[0-9]|2[0-3]) ;; *) exit 77;; esac; '
    : '';
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function snapshotCommitCommand(source, destination, env = process.env) {
  const guard = remoteUpdateGuard(env);
  return `${guard}set -e; test -s ${quote(source)}; chmod 0640 ${quote(source)}; ${guard}mv -f -- ${quote(source)} ${quote(destination)}`;
}
export function mediaCommitCommand(source, destination, env = process.env) {
  const guard = remoteUpdateGuard(env);
  return `${guard}set -e; mkdir -p -- ${quote(destination)}; chmod 0755 ${quote(destination)}; for f in ${quote(source)}/*; do chmod 0644 "$f"; ${guard}mv -f -- "$f" ${quote(destination + '/')}; done; rmdir -- ${quote(source)}`;
}
export function pausedResult() {
  return { skipped: true, reason: 'quiet-hours', timeZone: 'Asia/Shanghai', resumeAt: '08:00' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--check')) {
  if (!updatesAllowed()) { console.log(JSON.stringify(pausedResult())); process.exitCode = 1; }
}
