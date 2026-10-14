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
  -r "$staging_dir/deploy/requirements-production.lock"
chown -R ubuntu:ubuntu "$staging_dir"

# tar --no-same-permissions 会应用调用方的 umask；部署账户采用严格 umask 时，目录可能变成
# 0700，导致 Nginx 无法遍历到公开前端。只开放静态构建目录，不放宽源码、虚拟环境或 .local。
chmod 0755 "$staging_dir" "$staging_dir/desktop"
find "$staging_dir/desktop/dist" -type d -exec chmod 0755 {} +
find "$staging_dir/desktop/dist" -type f -exec chmod 0644 {} +
mv "$staging_dir" "$release_dir"

previous="$(readlink -f "$current_link" 2>/dev/null || true)"
[[ -n "$previous" && -d "$previous" ]] || { echo "旧发布目录不可用，请先完成首次部署布局" >&2; exit 2; }
switched=0
data_backup=""
paused=0
active_timers=()
resume_timers() {
  local failed=0
  for timer in "${active_timers[@]}"; do
    if ! systemctl start "$timer" || ! systemctl is-active --quiet "$timer"; then
      echo "后台任务恢复失败：$timer" >&2
      failed=1
    fi
  done
  return "$failed"
}
freeze_writers() {
  local failed=0
  for timer in vibe-research-gpu-refresh.timer vibe-research-update-check.timer; do
    if ! systemctl stop "$timer" "${timer%.timer}.service"; then failed=1; fi
    if systemctl is-active --quiet "$timer" || systemctl is-active --quiet "${timer%.timer}.service"; then
      echo "写入任务未停止：$timer" >&2
      failed=1
    fi
  done
  if ! systemctl stop "$service_name"; then failed=1; fi
  if systemctl is-active --quiet "$service_name"; then
    echo "主服务未停止" >&2
    failed=1
  fi
  return "$failed"
}
rollback() {
  status=$?
  trap - ERR
  if [[ "$paused" -eq 1 ]]; then
    if ! freeze_writers; then
      echo "回滚冻结失败，数据与发布目录已保留" >&2
      exit 5
    fi
    if [[ "$switched" -eq 1 && -n "$data_backup" ]]; then
      if ! python3 "$release_dir/deploy/data-snapshot.py" restore --backup "$data_backup"; then
        echo "数据恢复失败，服务保持停止" >&2
        exit 5
      fi
    fi
    if [[ -z "$previous" || ! -d "$previous" ]]; then
      echo "旧发布目录不可用，数据已保留，服务保持停止" >&2
      exit 6
    fi
    ln -s "$previous" "$current_link.rollback"
    mv -Tf "$current_link.rollback" "$current_link"
    if ! systemctl restart "$service_name" || ! /usr/local/sbin/vibe-healthcheck "https://soufly.cn/vibe-research" "$(basename "$previous")"; then
      systemctl stop "$service_name" || true
      echo "旧版恢复验证失败，发布目录及数据已保留" >&2
      exit 6
    fi
    if ! resume_timers; then
      echo "旧版应用已恢复，后台任务恢复失败" >&2
      exit 7
    fi
    echo "部署失败，已验证回滚到 $previous" >&2
  fi
  exit "$status"
}
trap rollback ERR
paused=1

for timer in vibe-research-gpu-refresh.timer vibe-research-update-check.timer; do
  if systemctl is-active --quiet "$timer"; then active_timers+=("$timer"); fi
done
freeze_writers
data_backup="$(python3 "$release_dir/deploy/data-snapshot.py" capture --commit "$commit_sha")"
printf '%s target=%s data_backup=%s previous=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit_sha" "$data_backup" "$previous" >> "$shared_dir/deployments.log"

ln -s "$release_dir" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"
switched=1
systemctl restart "$service_name"
/usr/local/sbin/vibe-healthcheck "https://soufly.cn/vibe-research" "$commit_sha"
resume_timers
switched=0
paused=0
trap - ERR
trap - EXIT

printf '%s commit=%s previous=%s status=success\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit_sha" "${previous:-none}" >> "$shared_dir/deployments.log"
rm -f -- "$archive"

# 健康检查通过后保留当前版本和两个成功旧版本；仍被进程或配置引用的目录保留。
if ! python3 - "$deploy_root" "$release_dir" "${previous:-}" <<'PY'
import json,os,pathlib,re,shutil,sys,tempfile
root=pathlib.Path(sys.argv[1]);releases=root/'releases';shared=root/'shared'
current=pathlib.Path(sys.argv[2]);previous=pathlib.Path(sys.argv[3]) if sys.argv[3] else None
if current.is_symlink() or not current.is_dir() or (root/'current').resolve()!=current:raise SystemExit('运行版本关系变化，保留旧目录')
pattern=re.compile(r'(?:[a-f0-9]{40}|bootstrap-[0-9]{14})')
marker=shared/'verified-releases.json';successful=set()
if marker.is_symlink():raise SystemExit('版本记录路径无效')
if marker.exists():
 successful.update(json.loads(marker.read_text())['commits'])
if any(not pattern.fullmatch(x) for x in successful):raise SystemExit('成功版本记录无效')
log=shared/'deployments.log'
if log.exists():
 for line in log.read_text().splitlines():
  if 'status=success' in line:
   match=re.search(r'commit=([a-f0-9]{40})',line)
   if match:successful.add(match.group(1))
successful.add(current.name)
candidates=[p for p in releases.iterdir() if not p.is_symlink() and p.is_dir() and pattern.fullmatch(p.name) and (p/'.local').is_symlink() and (p/'.local').resolve()==shared/'.local']
keep={current}
if previous and previous.is_dir():keep.add(previous)
for p in sorted(candidates,key=lambda p:p.stat().st_mtime,reverse=True):
 if p not in keep and p.name in successful and len(keep)<3:keep.add(p)
reference_pattern=re.compile(re.escape(str(releases))+'/([a-f0-9]{40}|bootstrap-[0-9]{14})')
def references(value):
 return {releases/m for m in reference_pattern.findall(value)}
for proc in pathlib.Path('/proc').iterdir():
 if not proc.name.isdigit():continue
 try:
  keep.update(references(os.readlink(proc/'cwd')))
  keep.update(references(os.readlink(proc/'exe')))
  keep.update(references((proc/'cmdline').read_bytes().decode(errors='replace')))
 except OSError:pass
for directory in ['/etc/systemd/system','/etc/nginx','/etc/cron.d','/var/spool/cron/crontabs']:
 for p in pathlib.Path(directory).rglob('*'):
  try:
   if p.is_symlink():keep.update(references(str(p.resolve())))
   if p.is_file():keep.update(references(p.read_text()))
  except (OSError,UnicodeError):pass
# 所有不会删除的目录都参与依赖保护，不占三个成功版本的名额。
all_directories={p for p in releases.iterdir() if p.is_dir() and not p.is_symlink()}
keep.update(p for p in all_directories if p not in candidates or p.name not in successful)
scanned=set()
while any(p not in scanned and p.is_dir() for p in keep):
 for retained in list(keep-scanned):
  scanned.add(retained)
  if not retained.is_dir():continue
  for directory,dirs,files in os.walk(retained,followlinks=False):
   for name in dirs+files:
    p=pathlib.Path(directory)/name
    if p.is_symlink():keep.update(references(str(p.resolve())))
  bins=retained/'.venv/bin'
  if bins.is_dir():
   for p in bins.iterdir():
    if p.is_file() and not p.is_symlink():
     with p.open('rb') as f:first=f.readline(4096).decode(errors='ignore')
     if first.startswith('#!'):keep.update(references(first))
removed=[]
for old in candidates:
 if old in keep or old.name not in successful:continue
 if (root/'current').resolve()!=current or old.is_symlink() or (old/'.local').resolve()!=shared/'.local':raise SystemExit('删除前版本或数据路径变化，停止清理')
 shutil.rmtree(old);removed.append(old.name)
marker.parent.mkdir(parents=True,exist_ok=True)
fd,name=tempfile.mkstemp(prefix='.verified-releases-',dir=marker.parent)
with os.fdopen(fd,'w') as output:json.dump({'commits':sorted(successful)},output)
os.replace(name,marker)
print(json.dumps({'pruned_releases':removed,'retained_releases':sorted(p.name for p in keep if p.is_dir()),'unverified_preserved':sorted(p.name for p in candidates if p.name not in successful)}))
PY
then
  echo "部署已成功，旧版本清理未完成，请检查维护日志" >&2
fi

echo "部署成功：$commit_sha"
