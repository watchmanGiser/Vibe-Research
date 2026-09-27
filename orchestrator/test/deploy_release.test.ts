import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

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


test("钉钉群结果路由必须要求站点账号且禁用缓存", () => {
  const nginx = fs.readFileSync(path.join(repoRoot, "deploy", "vibe-research.nginx.conf"), "utf8");
  const route = nginx.match(/location = \/vibe-research\/api\/semi\/dingtalk \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(route, "必须使用精确匹配的专用路由，不能公开落入通用 API 路由");
  assert.match(route, /auth_basic "/);
  assert.match(route, /auth_basic_user_file \/etc\/nginx\/\.htpasswd-vibe-research;/);
  assert.match(route, /include \/etc\/nginx\/snippets\/vibe-research-auth\.nginx\.conf;/);
  assert.match(route, /proxy_pass http:\/\/127\.0\.0\.1:8092\/semi\/dingtalk;/);
  assert.match(route, /Cache-Control "private, no-store"/);
});

test("Nova 原文定时器只能调用本地同步脚本，绝不执行推送", () => {
  const service = fs.readFileSync(path.join(repoRoot, "deploy", "vibe-research-dingtalk-raw.service"), "utf8");
  const timer = fs.readFileSync(path.join(repoRoot, "deploy", "vibe-research-dingtalk-raw.timer"), "utf8");
  assert.match(service, /ExecStart=.*sync-dingtalk-group\.mjs/);
  assert.doesNotMatch(service, /push-dingtalk-group|scp|ssh/);
  assert.match(timer, /Unit=vibe-research-dingtalk-raw\.service/);
});
