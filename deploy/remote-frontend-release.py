#!/usr/bin/env python3
"""原子切换前端静态文件，保留后端进程与持久数据。"""
import argparse
import ctypes
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import tempfile
from urllib.request import Request, urlopen

ROOT = Path('/opt/vibe-research')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def commit(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{40}', value):
        raise ValueError('提交号无效')
    return value


def read_json(path):
    return json.loads(path.read_text())


def frontend_commit(app):
    marker = app / 'desktop/dist/frontend-release.json'
    return commit(read_json(marker)['sourceCommit'] if marker.exists() else read_json(app / 'release.json')['commit'])


def exchange(left, right):
    # Linux RENAME_EXCHANGE 可以原子交换目录与链接，首次启用也没有空目录窗口。
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(left), -100, os.fsencode(right), 2) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def load_archive(archive, expected_commit, expected_digest):
    commit(expected_commit)
    if not re.fullmatch(r'[a-f0-9]{64}', expected_digest):
        raise ValueError('归档校验和无效')
    if archive.is_symlink() or not archive.is_file() or digest(archive.read_bytes()) != expected_digest:
        raise ValueError('归档缺失或校验和不一致')
    files = {}
    total = 0
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar.getmembers():
            parts = PurePosixPath(member.name).parts
            if (not parts or member.name.startswith('/') or '..' in parts or
                    member.name != '/'.join(parts) or member.name in files or
                    not member.isfile() or len(parts) > 20):
                raise ValueError('归档包含不允许的路径或条目')
            if member.name != 'frontend-release.json' and not (
                    parts[0] == 'dist' or (len(parts) > 2 and parts[:2] == ('source', 'desktop'))):
                raise ValueError('前端包包含其他目录')
            if any(p in {'.local', '.venv', 'node_modules'} or p.startswith('.env') for p in parts):
                raise ValueError('前端包包含私有或依赖目录')
            total += member.size
            if total > 50 * 1024 * 1024 or len(files) >= 5000:
                raise ValueError('前端包超过大小或文件数量限制')
            files[member.name] = tar.extractfile(member).read()
    manifest = json.loads(files.pop('frontend-release.json'))
    if manifest.get('schemaVersion') != 1 or manifest.get('kind') != 'frontend':
        raise ValueError('不是前端发布包')
    if commit(manifest['sourceCommit']) != expected_commit:
        raise ValueError('归档提交号不一致')
    commit(manifest['baseBackendCommit'])
    commit(manifest['baseFrontendCommit'])
    if manifest.get('files') != {name: digest(data) for name, data in files.items()}:
        raise ValueError('文件清单或内容校验失败')
    for name in ('dist/index.html', 'dist/dingtalk.html'):
        if name not in files or b'/vibe-research/assets/' not in files[name]:
            raise ValueError('生产入口或资源路径无效')
    return manifest, files


def verify_public(dist):
    origin = 'https://soufly.cn'
    def request(path):
        with urlopen(Request(origin + path, headers={'Cache-Control': 'no-cache'}), timeout=10) as response:
            if response.status != 200:
                raise ValueError('线上入口不可用')
            return response.read()
    resources = set()
    for route, name in [('/vibe-research/intel/dingtalk', 'index.html'), ('/dingtalk/', 'dingtalk.html')]:
        body = request(route)
        if body != (dist / name).read_bytes():
            raise ValueError('线上入口与新产物不一致')
        resources.update(re.findall(r'(?:src|href)="(/vibe-research/assets/[^"?#]+)"', body.decode()))
    for resource in resources:
        local = dist / 'assets' / resource.rsplit('/', 1)[1]
        if request(resource) != local.read_bytes():
            raise ValueError('线上资源与新产物不一致')
    if json.loads(request('/vibe-research/api/health')).get('ok') is not True:
        raise ValueError('后端健康检查失败')


def log_result(root, value):
    with (root / 'shared/frontend-deployments.log').open('a') as log:
        log.write(json.dumps(value, ensure_ascii=False) + '\n')


def publish(root, archive, expected_commit, expected_digest, healthcheck=verify_public):
    # 与完整发布共用锁；先复核后端和前端版本，避免覆盖并发发布。
    with (root / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest, files = load_archive(archive, expected_commit, expected_digest)
        app = (root / 'app').resolve(strict=True)
        if app.parent != root / 'releases':
            raise ValueError('运行目录不在受控发布目录')
        backend = commit(read_json(app / 'release.json')['commit'])
        if backend != manifest['baseBackendCommit'] or frontend_commit(app) != manifest['baseFrontendCommit']:
            raise ValueError('线上版本已变化，请重新核对基线')
        releases = root / 'frontend-releases'
        releases.mkdir(exist_ok=True)
        releases.chmod(0o755)
        release = releases / expected_commit
        if release.exists() or release.is_symlink():
            raise ValueError('前端版本目录已存在')
        stage = Path(tempfile.mkdtemp(prefix='.staging-', dir=releases))
        stage.chmod(0o755)
        backup = None
        switched = False
        try:
            for name, data in files.items():
                destination = stage / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
                destination.chmod(0o644)
            # 留住上一版的哈希资源，已打开的页面仍能完成延迟加载。
            old_dist = app / 'desktop/dist'
            old_manifest = old_dist.resolve().parent / 'frontend-release.json'
            old_assets = ([old_dist / name.removeprefix('dist/') for name in read_json(old_manifest)['files']
                           if name.startswith('dist/assets/')] if old_manifest.exists()
                          else list((old_dist / 'assets').rglob('*')))
            for asset in old_assets:
                if asset.is_file():
                    destination = stage / 'dist' / asset.relative_to(old_dist).as_posix()
                    if not destination.exists():
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(asset, destination)
                        destination.chmod(0o644)
            for directory in (stage / 'dist', *(stage / 'dist').rglob('*')):
                if directory.is_dir():
                    directory.chmod(0o755)
            (stage / 'frontend-release.json').write_text(json.dumps(manifest, ensure_ascii=False) + '\n')
            marker = {k: manifest[k] for k in ('schemaVersion', 'kind', 'sourceCommit', 'baseBackendCommit', 'baseFrontendCommit', 'builtAt')}
            (stage / 'dist/frontend-release.json').write_text(json.dumps(marker) + '\n')
            (stage / 'dist/frontend-release.json').chmod(0o644)
            stage.rename(release)
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            backup = root / 'shared/backups' / ('frontend-' + stamp)
            backup.mkdir(parents=True, mode=0o700)
            dist = app / 'desktop/dist'
            record = {'time': stamp, 'backendCommit': backend, 'previousFrontendCommit': frontend_commit(app),
                      'frontendCommit': expected_commit, 'app': str(app), 'archiveSha256': expected_digest,
                      'previousIndexSha256': digest((dist / 'index.html').read_bytes()),
                      'previousDingtalkSha256': digest((dist / 'dingtalk.html').read_bytes()), 'status': 'prepared'}
            (backup / 'manifest.json').write_text(json.dumps(record) + '\n')
            previous = backup / 'previous-dist'
            previous.symlink_to(release / 'dist')
            if (root / 'app').resolve() != app:
                raise ValueError('运行目录发生变化')
            exchange(previous, dist)
            switched = True
            healthcheck(dist)
            record['status'] = 'success'
            (backup / 'manifest.json').write_text(json.dumps(record) + '\n')
            log_result(root, record)
            return record
        except BaseException:
            if switched:
                exchange(backup / 'previous-dist', app / 'desktop/dist')
                switched = False
                log_result(root, {'frontendCommit': expected_commit, 'status': 'rolled_back'})
            if stage.exists():
                shutil.rmtree(stage)
            if release.exists():
                shutil.rmtree(release)
            raise


def rollback(root, backup, healthcheck=verify_public):
    with (root / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if backup.is_symlink() or backup.parent != root / 'shared/backups':
            raise ValueError('回滚点路径无效')
        record = read_json(backup / 'manifest.json')
        app = (root / 'app').resolve(strict=True)
        if str(app) != record['app'] or frontend_commit(app) != record['frontendCommit'] or record['status'] not in {'prepared', 'success'}:
            raise ValueError('当前版本已变化，拒绝覆盖后续发布')
        dist = app / 'desktop/dist'
        exchange(backup / 'previous-dist', dist)
        try:
            healthcheck(dist)
        except BaseException:
            exchange(backup / 'previous-dist', dist)
            raise
        record['status'] = 'manual_rollback'
        (backup / 'manifest.json').write_text(json.dumps(record) + '\n')
        log_result(root, record)
        return record


def main():
    if os.geteuid() != 0:
        raise SystemExit('生产发布必须由root执行')
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    deploy = commands.add_parser('publish')
    deploy.add_argument('commit')
    deploy.add_argument('archive', type=Path)
    deploy.add_argument('sha256')
    restore = commands.add_parser('rollback')
    restore.add_argument('backup', type=Path)
    args = parser.parse_args()
    if args.action == 'publish':
        if args.archive != ROOT / 'incoming' / ('frontend-' + commit(args.commit) + '.tar.gz'):
            raise SystemExit('归档必须位于受控incoming目录')
        result = publish(ROOT, args.archive, args.commit, args.sha256)
    else:
        result = rollback(ROOT, args.backup)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
