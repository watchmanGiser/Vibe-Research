#!/usr/bin/env python3
"""仅构建、打包前端；拒绝把后端变更混入页面发布。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone

TOOL_FILES = {
    'deploy/build-frontend-release.py',
    'deploy/remote-frontend-release.py',
    'deploy/test-frontend-release.py',
}


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()


def valid_commit(value):
    if not re.fullmatch(r'[a-f0-9]{40}', value):
        raise ValueError('需要完整的40位提交号')
    return value


def check_scope(repo, backend_commit, frontend_commit):
    target = valid_commit(git(repo, 'rev-parse', 'HEAD'))
    for base in (backend_commit, frontend_commit):
        valid_commit(base)
        subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', base, target], check=True)
    if git(repo, 'status', '--porcelain', '--untracked-files=normal'):
        raise ValueError('工作区有未提交文件，请只提交本次相关文件后再打包')
    changed = git(repo, 'diff', '--name-only', backend_commit, target).splitlines()
    allowed = lambda p: (p.startswith('desktop/') or p in TOOL_FILES or
                         p in {'AGENTS.md', 'README.md', 'README_en.md'} or
                         (p.startswith('docs/') and p.endswith('.md')))
    blocked = [p for p in changed if not allowed(p)]
    if blocked:
        raise ValueError('包含前端范围外的改动，使用对应后端或完整发布：' + ', '.join(blocked))
    return target


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def pack(repo, output, backend_commit, frontend_commit, target):
    dist = repo / 'desktop/dist'
    files = {}
    for p in sorted(dist.rglob('*')):
        if p.is_symlink():
            raise ValueError('前端构建不应包含符号链接')
        if p.is_file():
            files['dist/' + p.relative_to(dist).as_posix()] = p.read_bytes()
    for entry in ('dist/index.html', 'dist/dingtalk.html'):
        if entry not in files or b'/vibe-research/assets/' not in files[entry]:
            raise ValueError('缺少生产入口或生产子路径：' + entry)
    for name in git(repo, 'ls-files', 'desktop').splitlines():
        p = Path(name)
        if any(part in {'node_modules', '.local', '.venv'} or part.startswith('.env') for part in p.parts):
            raise ValueError('前端源码包含不应发布的路径：' + name)
        if not name.startswith('desktop/dist/'):
            files['source/' + name] = (repo / name).read_bytes()
    manifest = {
        'schemaVersion': 1, 'kind': 'frontend', 'sourceCommit': target,
        'baseBackendCommit': backend_commit, 'baseFrontendCommit': frontend_commit,
        'builtAt': datetime.now(timezone.utc).isoformat(),
        'files': {name: sha256(data) for name, data in files.items()},
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='vra-frontend-bundle-') as work:
        stage = Path(work)
        for name, data in files.items():
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        (stage / 'frontend-release.json').write_text(json.dumps(manifest, ensure_ascii=False) + '\n')
        with tarfile.open(output, 'w:gz') as archive:
            for p in sorted(stage.rglob('*')):
                if p.is_file():
                    archive.add(p, arcname=p.relative_to(stage).as_posix(), recursive=False)
    digest = sha256(output.read_bytes())
    Path(str(output) + '.sha256').write_text(digest + '  ' + output.name + '\n')
    print(json.dumps({'commit': target, 'archive': str(output), 'sha256': digest,
                      'bytes': output.stat().st_size}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backend_commit', help='线上 release.json 中的提交号')
    parser.add_argument('frontend_commit', help='线上前端提交号；首次与后端相同')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    target = check_scope(repo, args.backend_commit, args.frontend_commit)
    desktop = repo / 'desktop'
    lock_hash = sha256((desktop / 'package-lock.json').read_bytes())
    cache_marker = desktop / 'node_modules/.vra-package-lock.sha256'
    if not cache_marker.exists() or cache_marker.read_text().strip() != lock_hash:
        subprocess.run(['npm', 'ci', '--prefix', str(desktop), '--no-audit', '--no-fund'], check=True)
        cache_marker.write_text(lock_hash + '\n')
    else:
        print('前端依赖锁文件未变，复用已安装依赖', flush=True)
    build_env = {**os.environ, 'VITE_BASE_PATH': '/vibe-research/'}
    subprocess.run(['npm', 'run', 'build', '--prefix', str(desktop)], env=build_env, check=True)
    subprocess.run(['node', str(repo / 'scripts/check-guangzhou-customizations.mjs')], check=True)
    pack(repo, args.output.resolve(), args.backend_commit, args.frontend_commit, target)


if __name__ == '__main__':
    main()
