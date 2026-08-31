#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-https://soufly.cn/vibe-research}"
expected_sha="${2:-}"

health=""
for _ in $(seq 1 15); do
  if health="$(curl --fail --silent --show-error --max-time 10 "${base_url}/api/health" 2>/dev/null)"; then
    break
  fi
  sleep 2
done

if [[ "$health" != *'"ok":true'* ]]; then
  echo "健康检查失败：API /health 未返回 ok=true" >&2
  exit 1
fi

html="$(curl --fail --silent --show-error --max-time 10 "${base_url}/")"
if [[ "$html" != *"Vibe Research"* ]] || [[ "$html" != *"/vibe-research/assets/"* ]]; then
  echo "健康检查失败：首页不是预期的 Vibe Research 构建" >&2
  exit 1
fi

if [[ -n "$expected_sha" ]]; then
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "expected_sha 格式错误" >&2; exit 2; }
  main_pid="$(systemctl show vibe-research.service -p MainPID --value)"
  [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || { echo "健康检查失败：服务没有主进程" >&2; exit 1; }
  process_cwd="$(readlink -f "/proc/${main_pid}/cwd")"
  [[ "$process_cwd" == "/opt/vibe-research/releases/${expected_sha}" ]] || {
    echo "健康检查失败：运行中的进程不是预期版本 ${expected_sha}" >&2
    exit 1
  }
fi

echo "健康检查通过：${health}"
