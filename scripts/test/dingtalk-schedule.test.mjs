import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { updatesAllowed, windowPaused, updateDeadline, assertUpdateWindow, remoteUpdateGuard, snapshotCommitCommand, mediaCommitCommand } from '../dingtalk-schedule.mjs';
import { callCodex, callResponses } from '../dingtalk-model.mjs';
const enforced = { DINGTALK_ENFORCE_UPDATE_WINDOW: '1' };
const at = value => Date.parse(value);

test('北京时间凌晨1点到8点使用半开区间，与机器时区无关', () => {
  for (const [date, expected] of [
    ['2026-10-15T00:00:00+08:00', true], ['2026-10-15T00:59:59.999+08:00', true],
    ['2026-10-15T01:00:00+08:00', false], ['2026-10-15T07:59:59.999+08:00', false],
    ['2026-10-15T08:00:00+08:00', true], ['2026-10-15T23:59:59.999+08:00', true],
  ]) assert.equal(updatesAllowed(at(date)), expected, date);
  assert.equal(windowPaused(enforced, at('2026-10-15T03:00:00+08:00')), true);
  assert.equal(windowPaused({}, at('2026-10-15T03:00:00+08:00')), false, '未启用自动服务规则的维护脚本仍可独立测试');
});
test('在途任务时限裁到1点边界，暂停期间不能启动调用或提交', () => {
  assert.equal(updateDeadline(480000, enforced, at('2026-10-15T00:58:00+08:00')), at('2026-10-15T01:00:00+08:00'));
  assert.equal(updateDeadline(480000, enforced, at('2026-10-15T23:58:00+08:00')), at('2026-10-16T00:06:00+08:00'));
  assert.equal(updateDeadline(Infinity, enforced, at('2026-12-31T23:58:00+08:00')), at('2027-01-01T01:00:00+08:00'));
  assert.equal(updateDeadline(480000, enforced, at('2026-10-15T07:00:00+08:00')), at('2026-10-15T07:00:00+08:00'));
  assert.throws(() => assertUpdateWindow(enforced, at('2026-10-15T01:00:00+08:00')), error => error.code === 'QUIET_HOURS');
});
test('夜间模型入口先拒绝，再计账，避免没有请求也多扣尝试或额度', async () => {
  const oldClock = Date.now, previous = process.env.DINGTALK_ENFORCE_UPDATE_WINDOW;
  try {
    Date.now = () => at('2026-10-15T03:00:00+08:00'); process.env.DINGTALK_ENFORCE_UPDATE_WINDOW = '1';
    const ledger = { start() { assert.fail('暂停期间不能启动模型或计费'); } };
    await assert.rejects(callCodex({ ledger, timeout: 100, bin: '/bin/false', args: [], input: '' }), error => error.code === 'QUIET_HOURS');
    await assert.rejects(callResponses({ ledger, timeout: 100, endpoint: 'https://example.invalid/v1/responses' }), error => error.code === 'QUIET_HOURS');
  } finally { Date.now = oldClock; if (previous === undefined) delete process.env.DINGTALK_ENFORCE_UPDATE_WINDOW; else process.env.DINGTALK_ENFORCE_UPDATE_WINDOW = previous; }
});
test('夜间原文、整理及发布入口均直接跳过，不需要读取资料或凭据', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-night-'));
  try {
    const clock = path.join(directory, 'clock.mjs');
    fs.writeFileSync(clock, `Date.now=()=>${at('2026-10-15T03:00:00+08:00')};`);
    for (const filename of ['sync-dingtalk-group.mjs', 'push-dingtalk-group.mjs', 'publish-dingtalk-raw.mjs']) {
      const file = new URL('../' + filename, import.meta.url).pathname;
      const result = spawnSync(process.execPath, ['--import', clock, file], { env: { PATH: process.env.PATH, DINGTALK_ENFORCE_UPDATE_WINDOW: '1' }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).reason, 'quiet-hours', filename);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('远端提交前重新检查北京时间，源端开始较早也不能跨夜发布', () => {
  const guard = remoteUpdateGuard(enforced);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-night-remote-'));
  try {
    const file = path.join(directory, 'date');
    fs.writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$TEST_HOUR"\n', { mode: 0o700 });
    for (const hour of ['01', '03', '07']) {
      const result = spawnSync('/bin/sh', ['-c', guard + 'printf committed'], { env: { PATH: directory + ':' + process.env.PATH, TEST_HOUR: hour }, encoding: 'utf8' });
      assert.equal(result.status, 77); assert.equal(result.stdout, '');
    }
    const result = spawnSync('/bin/sh', ['-c', guard + 'printf committed'], { env: { PATH: directory + ':' + process.env.PATH, TEST_HOUR: '08' }, encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(result.stdout, 'committed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('实际systemd解析日历：凌晨不追赶，8点后每10分钟触发', t => {
  for (const [name, minute] of [['raw', '00'], ['push', '01']]) {
    const file = new URL(`../../deploy/vibe-research-dingtalk-${name}.timer`, import.meta.url).pathname;
    const text = fs.readFileSync(file, 'utf8'), calendar = text.match(/^OnCalendar=(.+)$/m)[1];
    const result = spawnSync('systemd-analyze', ['calendar', '--base-time=2026-10-15 00:59:59 Asia/Shanghai', '--iterations=3', calendar], { encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
    if (result.error?.code === 'ENOENT') { t.skip('当前环境没有systemd；生产机已做解析验证'); return; }
    assert.equal(result.status, 0, result.stderr);
    const triggers = result.stdout.split('\n').filter(line => /Next elapse:|Iteration #/.test(line));
    assert.equal(triggers.length, 3); assert.ok(triggers[0].includes(`2026-10-15 08:${minute}:00`));
    assert.ok(triggers.every(line => !/2026-10-15 0[1-7]:/.test(line)));
    assert.match(text, /Persistent=false/); assert.doesNotMatch(text, /OnBootSec=|OnUnitActiveSec=/);
  }
});

test('远端chmod期间跨到1点，快照与媒体每次替换前都再次拒绝', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-night-transition-'));
  try {
    const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
    const clock = path.join(directory, 'hour'); fs.writeFileSync(clock, '00');
    fs.writeFileSync(path.join(bin, 'date'), '#!/bin/sh\ncat "$TEST_CLOCK"\n', { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'chmod'), '#!/bin/sh\nprintf "01" > "$TEST_CLOCK"\n', { mode: 0o700 });
    const env = { ...process.env, PATH: bin + ':' + process.env.PATH, TEST_CLOCK: clock };
    const temporary = path.join(directory, 'incoming.json'), destination = path.join(directory, 'existing.json');
    fs.writeFileSync(temporary, 'new'); fs.writeFileSync(destination, 'old');
    let result = spawnSync('/bin/sh', ['-c', snapshotCommitCommand(temporary, destination, enforced)], { env, encoding: 'utf8' });
    assert.equal(result.status, 77); assert.equal(fs.readFileSync(destination, 'utf8'), 'old');
    assert.equal(fs.existsSync(temporary), true);
    fs.writeFileSync(clock, '00');
    const media = path.join(directory, 'incoming-media'), published = path.join(directory, 'existing-media'); fs.mkdirSync(media); fs.writeFileSync(path.join(media, 'image.png'), 'new-image');
    result = spawnSync('/bin/sh', ['-c', mediaCommitCommand(media, published, enforced)], { env, encoding: 'utf8' });
    assert.equal(result.status, 77); assert.equal(fs.existsSync(path.join(published, 'image.png')), false);
    assert.equal(fs.existsSync(path.join(media, 'image.png')), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('远端取时失败或返回非法小时也停止提交，保留原快照和媒体', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-clock-failed-'));
  try {
    const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
    const clock = path.join(directory, 'hour');
    fs.writeFileSync(path.join(bin, 'date'), '#!/bin/sh\nif [ "$(cat "$TEST_CLOCK")" = fail ]; then exit 1; fi; cat "$TEST_CLOCK"\n', { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'chmod'), '#!/bin/sh\nprintf "%s" "$TEST_CLOCK_FAILURE" > "$TEST_CLOCK"\n', { mode: 0o700 });
    for (const failure of ['fail', 'invalid', '24', '']) {
      const env = { ...process.env, PATH: bin + ':' + process.env.PATH, TEST_CLOCK: clock, TEST_CLOCK_FAILURE: failure };
      fs.writeFileSync(clock, '00');
      const incoming = path.join(directory, 'incoming'), destination = path.join(directory, 'destination');
      fs.writeFileSync(incoming, 'new'); fs.writeFileSync(destination, 'old');
      let result = spawnSync('/bin/sh', ['-c', snapshotCommitCommand(incoming, destination, enforced)], { env, encoding: 'utf8' });
      assert.equal(result.status, 77); assert.equal(fs.readFileSync(destination, 'utf8'), 'old');
      fs.writeFileSync(clock, '00');
      const media = path.join(directory, 'incoming-media'), published = path.join(directory, 'published-media'); fs.mkdirSync(media, { recursive: true }); fs.writeFileSync(path.join(media, 'image.png'), 'image');
      result = spawnSync('/bin/sh', ['-c', mediaCommitCommand(media, published, enforced)], { env, encoding: 'utf8' });
      assert.equal(result.status, 77); assert.equal(fs.existsSync(path.join(published, 'image.png')), false);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
