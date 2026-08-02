#!/usr/bin/env bash
# =============================================================================
# Vibe-Research → T480 服务器 部署脚本
#
# 目标机：ThinkPad T480 · Ubuntu · zzp@192.168.50.95（局域网）
#         已装 Docker CE 29.6.1 + compose v5.3.0。
#
# 从本机（Git Bash / Linux / macOS）运行，经 ssh/scp/tar 编排，可重跑。
# 代码打包传输（非 git），因不推送部署文件/补丁到上游仓库。
#
# 访问：绑 0.0.0.0:8900 → 局域网 http://192.168.50.95:8900
#       本机前端 Vite proxy 过去，无需直接访问后端。
#
# 用法：
#   scripts/deploy-vibe-research.sh init       # 首次：传代码 + 构建启动 + 验证
#   scripts/deploy-vibe-research.sh update      # 更新：重传代码 + 重建重启
#   scripts/deploy-vibe-research.sh status      # 容器状态 + 健康检查
#   scripts/deploy-vibe-research.sh logs        # 跟随日志
#   scripts/deploy-vibe-research.sh teardown    # 停止（保留数据卷）
# =============================================================================
set -euo pipefail

# --- 配置 --------------------------------------------------------------------
SSH_KEY="${SSH_KEY:-$HOME/.ssh/t480_key}"
REMOTE_USER="zzp"
REMOTE_HOST="${REMOTE_HOST:-192.168.50.95}"
SSH_PORT="${SSH_PORT:-22}"
REMOTE_DIR="/home/${REMOTE_USER}/vibe-research"
COMPOSE_FILE="docker-compose.yml"
APP_PORT="8900"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARBALL="/tmp/vibe-research-t480.tar.gz"
REMOTE_TARBALL="/tmp/vibe-research-t480.tar.gz"

SSH() { ssh -i "$SSH_KEY" -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=6 "${REMOTE_USER}@${REMOTE_HOST}" "$@"; }
SCP() { scp -i "$SSH_KEY" -P "$SSH_PORT" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=10 -o ServerAliveCountMax=6 "$@"; }
log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

# --- 步骤 --------------------------------------------------------------------

step_preflight() {
  log "预检：SSH 连通 + Docker 就绪"
  SSH 'echo "  host: $(hostname) / $(uname -m)"; docker --version; docker compose version | head -1' \
    || { echo "❌ 无法连接 T480 或 Docker 不可用"; exit 1; }
}

step_pack() {
  log "打包项目（排除 node_modules/.venv/.git/构建产物）"
  rm -f "$TARBALL"
  tar -czf "$TARBALL" -C "$PROJECT_ROOT" \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='frontend/node_modules' \
    --exclude='frontend/dist' \
    --exclude='.venv' \
    --exclude='backend/.venv' \
    --exclude='**/__pycache__' \
    --exclude='*.pyc' \
    --exclude='*.log' \
    .
  echo "  → $(du -h "$TARBALL" | cut -f1) $TARBALL"
}

step_transfer() {
  log "传输到 T480:${REMOTE_DIR}"
  SCP "$TARBALL" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_TARBALL}"
  SSH "mkdir -p '${REMOTE_DIR}' && tar -xzf '${REMOTE_TARBALL}' -C '${REMOTE_DIR}' && rm -f '${REMOTE_TARBALL}' && echo '  解包完成'"
}

step_build_up() {
  log "构建并启动容器（首次拉基础镜像 + pip install 依赖，约 2-5 分钟）"
  SSH "cd '${REMOTE_DIR}' && docker compose -f '${COMPOSE_FILE}' down --remove-orphans 2>/dev/null || true"
  SSH "cd '${REMOTE_DIR}' && docker compose -f '${COMPOSE_FILE}' up -d --build --force-recreate"
}

step_wait_health() {
  log "等待健康检查"
  SSH "for i in \$(seq 1 60); do \
        if curl -sf http://localhost:${APP_PORT}/api/health >/dev/null 2>&1; then echo '  ✅ healthy'; exit 0; fi; \
        sleep 3; done; \
      echo '  ⚠️ 健康检查超时，查看日志：deploy-vibe-research.sh logs'; exit 1"
}

step_report() {
  local lan_ip="$REMOTE_HOST"
  log "部署完成 ✅"
  cat <<EOF
  ┌────────────────────────────────────────────────────────────
  │ 后端（T480 Docker）： ${lan_ip}:${APP_PORT}
  │ 本机前端访问：        cd frontend && npm run dev
  │                      （设 VITE_API_URL=http://${lan_ip}:${APP_PORT}）
  │ 本机启动脚本：         .\\启动-连T480.ps1 [-Lan]
  └────────────────────────────────────────────────────────────
EOF
}

# --- 命令 --------------------------------------------------------------------

cmd_init() {
  step_preflight
  step_pack
  step_transfer
  step_build_up
  step_wait_health
  step_report
}

cmd_update() {
  step_preflight
  step_pack
  step_transfer
  step_build_up
  step_wait_health
  step_report
}

cmd_status() {
  log "容器状态"
  SSH "cd '${REMOTE_DIR}' && docker compose -f '${COMPOSE_FILE}' ps"
  log "健康检查"
  SSH "curl -s http://localhost:${APP_PORT}/api/health || echo '  不可达'"
}

cmd_logs() {
  SSH "cd '${REMOTE_DIR}' && docker compose -f '${COMPOSE_FILE}' logs -f --tail=100"
}

cmd_teardown() {
  log "停止容器（保留数据卷）"
  SSH "cd '${REMOTE_DIR}' && docker compose -f '${COMPOSE_FILE}' down"
}

case "${1:-}" in
  init)     cmd_init ;;
  update)   cmd_update ;;
  status)   cmd_status ;;
  logs)     cmd_logs ;;
  teardown) cmd_teardown ;;
  *) echo "用法: $0 {init|update|status|logs|teardown}"; exit 1 ;;
esac
