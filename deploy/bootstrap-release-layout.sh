#!/usr/bin/env bash
set -euo pipefail

deploy_root="/opt/vibe-research"
app_path="$deploy_root/app"
current_link="$deploy_root/current"
shared_dir="$deploy_root/shared"
releases_dir="$deploy_root/releases"
incoming_dir="$deploy_root/incoming"

[[ "${EUID}" -eq 0 ]] || { echo "必须由 root 执行" >&2; exit 2; }
[[ "$#" -eq 1 ]] || { echo "用法: bootstrap-release-layout.sh <部署公钥文件>" >&2; exit 2; }
public_key_file="$1"
[[ -f "$public_key_file" && ! -L "$public_key_file" ]] || { echo "部署公钥文件不存在或是符号链接" >&2; exit 2; }
public_key="$(<"$public_key_file")"
[[ "$public_key" =~ ^ssh-ed25519[[:space:]][A-Za-z0-9+/=]+([[:space:]].*)?$ ]] || { echo "只接受单行 Ed25519 部署公钥" >&2; exit 2; }
[[ -d "$app_path" && ! -L "$app_path" ]] || { echo "app 已迁移或当前结构不符合预期" >&2; exit 2; }
[[ ! -e "$current_link" ]] || { echo "current 已存在，拒绝重复迁移" >&2; exit 2; }
[[ -d "$app_path/.local" && ! -L "$app_path/.local" ]] || { echo "现有 .local 不符合预期" >&2; exit 2; }
[[ ! -e "$shared_dir/.local" ]] || { echo "shared/.local 已存在，拒绝覆盖" >&2; exit 2; }

bootstrap_name="bootstrap-$(date -u +%Y%m%d%H%M%S)"
bootstrap_release="$releases_dir/$bootstrap_name"

if ! id vibe-deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash vibe-deploy
fi
deploy_home="$(getent passwd vibe-deploy | cut -d: -f6)"
install -d -m 0700 -o vibe-deploy -g vibe-deploy "$deploy_home/.ssh"
printf '%s\n' "$public_key" > "$deploy_home/.ssh/authorized_keys"
chown vibe-deploy:vibe-deploy "$deploy_home/.ssh/authorized_keys"
chmod 0600 "$deploy_home/.ssh/authorized_keys"

systemctl stop vibe-research.service
restore_service() { systemctl start vibe-research.service || true; }
trap restore_service ERR

install -d -m 0755 "$releases_dir" "$shared_dir"
install -d -m 0750 -o vibe-deploy -g vibe-deploy "$incoming_dir"
mv "$app_path/.local" "$shared_dir/.local"
ln -s "$shared_dir/.local" "$app_path/.local"
mv "$app_path" "$bootstrap_release"
ln -s "$bootstrap_release" "$current_link"
ln -s "$current_link" "$app_path"

install -m 0755 "$bootstrap_release/deploy/remote-release.sh" /usr/local/sbin/vibe-release
install -m 0755 "$bootstrap_release/deploy/healthcheck.sh" /usr/local/sbin/vibe-healthcheck
install -m 0644 "$bootstrap_release/deploy/vibe-research.service" /etc/systemd/system/vibe-research.service
install -m 0644 "$bootstrap_release/deploy/vibe-research-gpu-refresh.service" /etc/systemd/system/vibe-research-gpu-refresh.service
install -m 0644 "$bootstrap_release/deploy/vibe-research-gpu-refresh.timer" /etc/systemd/system/vibe-research-gpu-refresh.timer
printf 'vibe-deploy ALL=(root) NOPASSWD: /usr/local/sbin/vibe-release\n' > /etc/sudoers.d/vibe-research-deploy
chmod 0440 /etc/sudoers.d/vibe-research-deploy
visudo -cf /etc/sudoers.d/vibe-research-deploy

systemctl daemon-reload
systemctl start vibe-research.service
"$bootstrap_release/deploy/healthcheck.sh" "https://soufly.cn/vibe-research"
trap - ERR
echo "发布目录迁移完成：$bootstrap_release"
