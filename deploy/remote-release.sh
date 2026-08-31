#!/usr/bin/env bash
set -euo pipefail

deploy_root="/opt/vibe-research"
releases_dir="$deploy_root/releases"
shared_dir="$deploy_root/shared"
incoming_dir="$deploy_root/incoming"
current_link="$deploy_root/current"
service_name="vibe-research.service"

[[ "${EUID}" -eq 0 ]] || { echo "必须由 root 执行" >&2; exit 2; }
[[ "$#" -eq 3 ]] || { echo "用法: vibe-release <40位 commit sha> <tar.gz 路径> <sha256>" >&2; exit 2; }

commit_sha="$1"
archive="$2"
archive_sha256="$3"
[[ "$commit_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "commit sha 格式错误" >&2; exit 2; }
[[ "$archive_sha256" =~ ^[0-9a-f]{64}$ ]] || { echo "归档 sha256 格式错误" >&2; exit 2; }
[[ "$archive" == "$incoming_dir/release-${commit_sha}.tar.gz" ]] || { echo "归档路径不在受控 incoming 目录" >&2; exit 2; }
[[ -f "$archive" && ! -L "$archive" ]] || { echo "发布包不存在或是符号链接" >&2; exit 2; }

exec 9>"$deploy_root/deploy.lock"
flock -n 9 || { echo "已有生产部署正在进行" >&2; exit 3; }

actual_sha256="$(sha256sum "$archive" | awk '{print $1}')"
[[ "$actual_sha256" == "$archive_sha256" ]] || { echo "发布包校验和不一致" >&2; exit 2; }

while IFS= read -r entry; do
  [[ "$entry" != /* && "$entry" != *"../"* && "$entry" != ".." ]] || {
    echo "发布包包含越界路径：$entry" >&2
    exit 2
  }
done < <(tar -tzf "$archive")

# 归档只能包含普通文件和目录。拒绝符号链接、硬链接与设备节点，避免解包时借链接越出 staging。
while IFS= read -r mode _; do
  kind="${mode:0:1}"
  [[ "$kind" == "-" || "$kind" == "d" ]] || {
    echo "发布包包含不允许的归档条目类型：$mode" >&2
    exit 2
  }
done < <(tar -tvzf "$archive")

release_dir="$releases_dir/$commit_sha"
staging_dir="$releases_dir/.staging-$commit_sha"
[[ ! -e "$release_dir" && ! -e "$staging_dir" ]] || { echo "该 commit 已经部署或正在准备" >&2; exit 2; }
cleanup_staging() {
  [[ ! -d "$staging_dir" ]] || rm -rf -- "$staging_dir"
}
trap cleanup_staging EXIT

mkdir -p "$releases_dir" "$shared_dir/.local" "$incoming_dir"
install -d -m 0755 -o ubuntu -g ubuntu "$staging_dir"
tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$staging_dir"

[[ -f "$staging_dir/orchestrator/src/api.ts" ]] || { echo "发布包缺少 API 入口" >&2; exit 2; }
[[ -f "$staging_dir/desktop/dist/index.html" ]] || { echo "发布包缺少前端构建" >&2; exit 2; }
[[ -f "$staging_dir/release.json" ]] || { echo "发布包缺少 release.json" >&2; exit 2; }
[[ ! -e "$staging_dir/.local" ]] || { echo "发布包不允许携带 .local" >&2; exit 2; }
release_commit="$(node -e "const x=require(process.argv[1]); process.stdout.write(String(x.commit||''))" "$staging_dir/release.json")"
[[ "$release_commit" == "$commit_sha" ]] || { echo "release.json 与目标 commit 不一致" >&2; exit 2; }

ln -s "$shared_dir/.local" "$staging_dir/.local"
python3 -m venv "$staging_dir/.venv"
"$staging_dir/.venv/bin/python" -m pip install --disable-pip-version-check \
  -r "$staging_dir/.agents/skills/data-access/scripts/requirements.txt"
chown -R ubuntu:ubuntu "$staging_dir"
mv "$staging_dir" "$release_dir"

previous="$(readlink -f "$current_link" 2>/dev/null || true)"
switched=0
rollback() {
  status=$?
  if [[ "$switched" -eq 1 && -n "$previous" && -d "$previous" ]]; then
    ln -s "$previous" "$current_link.rollback"
    mv -Tf "$current_link.rollback" "$current_link"
    systemctl restart "$service_name" || true
    /usr/local/sbin/vibe-healthcheck "https://soufly.cn/vibe-research" || true
    if [[ "$(readlink -f "$current_link")" != "$release_dir" && -d "$release_dir" ]]; then
      rm -rf -- "$release_dir"
    fi
    echo "部署失败，已回滚到 $previous" >&2
  fi
  exit "$status"
}
trap rollback ERR

ln -s "$release_dir" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"
switched=1
systemctl restart "$service_name"
/usr/local/sbin/vibe-healthcheck "https://soufly.cn/vibe-research" "$commit_sha"
switched=0
trap - ERR
trap - EXIT

printf '%s commit=%s previous=%s status=success\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit_sha" "${previous:-none}" >> "$shared_dir/deployments.log"
rm -f -- "$archive"

# 当前版本之外最多保留四个旧版本。只删除名称经过严格校验的版本目录。
mapfile -t old_releases < <(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk 'NR>5 {print $2}')
for old in "${old_releases[@]}"; do
  name="$(basename "$old")"
  [[ "$name" =~ ^([0-9a-f]{40}|bootstrap-[0-9]{14})$ ]] || continue
  [[ "$(readlink -f "$current_link")" != "$old" ]] || continue
  rm -rf -- "$old"
done

echo "部署成功：$commit_sha"
