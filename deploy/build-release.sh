#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:?用法: build-release.sh <输出 tar.gz> <40位 commit sha>}"
commit_sha="${2:?用法: build-release.sh <输出 tar.gz> <40位 commit sha>}"

[[ "$commit_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "commit sha 格式错误" >&2; exit 2; }
[[ -f "$repo_root/desktop/dist/index.html" ]] || { echo "请先构建 desktop/dist" >&2; exit 2; }
node "$repo_root/scripts/check-guangzhou-customizations.mjs"

stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT

rsync -a \
  --exclude '/.git' \
  --exclude '/.github/' \
  --exclude '/.local/' \
  --exclude '/.venv/' \
  --exclude '/.playwright-cli/' \
  --exclude '/desktop/node_modules/' \
  --exclude '/orchestrator/node_modules/' \
  --exclude '/backend/' \
  --exclude '/frontend/' \
  --exclude '/deploy/soufly.nginx' \
  "$repo_root/" "$stage/app/"

npm ci --omit=dev --prefix "$stage/app/orchestrator"
# npm 会为依赖的命令行入口自动创建 .bin 符号链接；生产服务只通过 Node import 依赖，
# 不使用这些开发期入口。远端为防止解包路径逃逸拒绝所有链接，因此归档前必须移除。
rm -rf -- "$stage/app/orchestrator/node_modules/.bin"
install -m 0644 "$repo_root/deploy/refresh-gpu.mjs" "$stage/app/scripts/refresh-gpu.mjs"
printf '{"commit":"%s","built_at":"%s"}\n' "$commit_sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$stage/app/release.json"

unexpected_link="$(find "$stage/app" -type l -print -quit)"
[[ -z "$unexpected_link" ]] || { echo "发布 staging 仍包含符号链接：$unexpected_link" >&2; exit 2; }

mkdir -p "$(dirname "$output")"
tar -C "$stage/app" -czf "$output" .
sha256sum "$output" > "${output}.sha256"
echo "发布包已生成：$output"
