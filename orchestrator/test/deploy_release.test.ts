import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("发布包移除 npm 命令入口，并在打包前拒绝残留符号链接", () => {
  const build = fs.readFileSync(path.join(repoRoot, "deploy", "build-release.sh"), "utf8");
  const remote = fs.readFileSync(path.join(repoRoot, "deploy", "remote-release.sh"), "utf8");

  assert.match(build, /rm -rf -- "\$stage\/app\/orchestrator\/node_modules\/\.bin"/);
  assert.match(build, /find "\$stage\/app" -type l -print -quit/);
  assert.match(remote, /kind" == "-" \|\| "\$kind" == "d"/);
});

test("远端发布只为 Nginx 开放静态构建目录", () => {
  const remote = fs.readFileSync(path.join(repoRoot, "deploy", "remote-release.sh"), "utf8");

  assert.match(remote, /chmod 0755 "\$staging_dir" "\$staging_dir\/desktop"/);
  assert.match(remote, /find "\$staging_dir\/desktop\/dist" -type d -exec chmod 0755/);
  assert.match(remote, /find "\$staging_dir\/desktop\/dist" -type f -exec chmod 0644/);
  assert.doesNotMatch(remote, /chmod -R/);
});


test("工作台页面及数据接口免登录，钉钉保留原文总结专用路由", () => {
  const nginx = fs.readFileSync(path.join(repoRoot, "deploy", "vibe-research.nginx.conf"), "utf8");
  const route = nginx.match(/location = \/vibe-research\/api\/semi\/dingtalk \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(route, "原文和总结必须走专用精确路由");
  assert.match(route, /auth_basic off;/);
  assert.doesNotMatch(route, /auth_basic_user_file/);
  assert.match(route, /include \/etc\/nginx\/snippets\/vibe-research-auth\.nginx\.conf;/);
  assert.match(route, /proxy_pass http:\/\/127\.0\.0\.1:8092\/semi\/dingtalk;/);
  assert.match(route, /Cache-Control "private, no-store"/);
  const page = nginx.match(/location = \/vibe-research\/intel\/dingtalk \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(page);
  assert.match(page, /auth_basic off;/);
  assert.match(page, /alias \/opt\/vibe-research\/app\/desktop\/dist\/index\.html;/);
  const api = nginx.match(/location \^~ \/vibe-research\/api\/ \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(api);
  assert.match(api, /auth_basic off;/);
  assert.doesNotMatch(nginx, /auth_basic "Vibe Research"|auth_basic_user_file|vra_dingtalk_public_visitor/);
});

test("Nova 原文定时器同步后调用独立原文发布入口", () => {
  const service = fs.readFileSync(path.join(repoRoot, "deploy", "vibe-research-dingtalk-raw.service"), "utf8");
  const timer = fs.readFileSync(path.join(repoRoot, "deploy", "vibe-research-dingtalk-raw.timer"), "utf8");
  assert.match(service, /ExecStart=.*sync-dingtalk-group\.mjs/);
  assert.match(service, /ExecStartPost=.*publish-dingtalk-raw\.mjs/);
  assert.doesNotMatch(service, /push-dingtalk-group|scp|ssh/);
  assert.match(timer, /Unit=vibe-research-dingtalk-raw\.service/);
});

test("数据回滚还原旧记录并保留升级后新增内容，快照被篡改时拒绝恢复", () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "vra-data-rollback-"));
  const shared = path.join(root, "shared", ".local");
  const python = process.env.VRA_PYTHON || "python3";
  const tool = path.join(repoRoot, "deploy", "data-snapshot.py");
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
  const record = path.join(shared, "record.json");
  fs.writeFileSync(record, '{"legacy":"original"}', { mode: 0o600 });
  try {
    const capture = spawnSync(python, [tool, "capture", "--root", root, "--commit", "a".repeat(40)], { encoding: "utf8" });
    assert.equal(capture.status, 0, capture.stderr);
    const backup = capture.stdout.trim();
    fs.writeFileSync(record, '{"new":"migrated"}');
    fs.writeFileSync(path.join(shared, "after.txt"), "升级后新增记录");
    const restore = spawnSync(python, [tool, "restore", "--root", root, "--backup", backup], { encoding: "utf8" });
    assert.equal(restore.status, 0, restore.stderr);
    assert.equal(fs.readFileSync(record, "utf8"), '{"legacy":"original"}');
    assert.equal(fs.statSync(record).mode & 0o777, 0o600);
    assert.equal(fs.statSync(record).uid, process.getuid?.());
    assert.equal(fs.readFileSync(path.join(restore.stdout.trim(), "after.txt"), "utf8"), "升级后新增记录");
    const second = spawnSync(python, [tool, "capture", "--root", root, "--commit", "b".repeat(40)], { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    fs.writeFileSync(path.join(second.stdout.trim(), ".local", "record.json"), "被篡改");
    const refused = spawnSync(python, [tool, "restore", "--root", root, "--backup", second.stdout.trim()], { encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.equal(fs.readFileSync(record, "utf8"), '{"legacy":"original"}');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("后台冻结失败也继续尝试停止所有其他写入者", () => {
  const source = fs.readFileSync(path.join(repoRoot, "deploy", "remote-release.sh"), "utf8");
  const freeze = source.slice(source.indexOf("freeze_writers() {"), source.indexOf("rollback() {"));
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "vra-freeze-"));
  const log = path.join(root, "calls.txt");
  const script = `service_name=vibe-research.service
systemctl() {
  if [[ "$1" == "stop" ]]; then
    printf '%s\\n' "$*" >> "$VRA_TEST_CALLS"
    [[ "$2" != "vibe-research-gpu-refresh.timer" ]]
    return $?
  fi
  return 3
}
${freeze}
freeze_writers
exit $?
`;
  try {
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, VRA_TEST_CALLS: log } });
    assert.equal(result.status, 1, result.stderr);
    const calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /stop vibe-research-gpu-refresh.timer vibe-research-gpu-refresh.service/);
    assert.match(calls, /stop vibe-research-update-check.timer vibe-research-update-check.service/);
    assert.match(calls, /stop vibe-research.service/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
