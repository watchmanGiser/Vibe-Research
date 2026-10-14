#!/usr/bin/env python3
"""验证前端发布的原子切换、版本保护、资源保留和失败回退。"""
import fcntl
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent

def module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

remote = module('frontend_remote', 'remote-frontend-release.py')
builder = module('frontend_builder', 'build-frontend-release.py')
A, B, C = ('a' * 40, 'b' * 40, 'c' * 40)


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='vra-front-test-')
        self.root = Path(self.temp.name)
        self.app = self.root / 'releases' / A
        self.dist = self.app / 'desktop/dist'
        (self.dist / 'assets').mkdir(parents=True)
        (self.dist / 'index.html').write_text('<script src="/vibe-research/assets/old.js"></script>')
        (self.dist / 'dingtalk.html').write_text('<script src="/vibe-research/assets/old.js"></script>')
        (self.dist / 'assets/old.js').write_text('old')
        (self.app / 'release.json').write_text(json.dumps({'commit': A}))
        (self.root / 'app').symlink_to(self.app)
        (self.root / 'shared/.local').mkdir(parents=True)
        (self.root / 'shared/.local/record.json').write_text('原始持久数据')
        (self.root / 'incoming').mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def bundle(self, target=B, base=A, extra=None):
        files = {'dist/index.html': b'<script src="/vibe-research/assets/new.js"></script>',
                 'dist/dingtalk.html': b'<script src="/vibe-research/assets/new.js"></script>',
                 'dist/assets/new.js': target.encode(), 'source/desktop/src/page.tsx': b'new'}
        if extra:
            files.update(extra)
        manifest = {'schemaVersion': 1, 'kind': 'frontend', 'sourceCommit': target,
                    'baseBackendCommit': A, 'baseFrontendCommit': base, 'builtAt': '2026-10-14T00:00:00Z',
                    'files': {p: hashlib.sha256(data).hexdigest() for p, data in files.items()}}
        files['frontend-release.json'] = json.dumps(manifest).encode()
        archive = self.root / 'incoming' / ('frontend-' + target + '.tar.gz')
        with tarfile.open(archive, 'w:gz') as tar:
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        return archive, hashlib.sha256(archive.read_bytes()).hexdigest()

    def publish(self, target=B, base=A, healthcheck=lambda _: None):
        archive, sha = self.bundle(target, base)
        return remote.publish(self.root, archive, target, sha, healthcheck)

    def assert_data(self):
        self.assertEqual((self.root / 'shared/.local/record.json').read_text(), '原始持久数据')
        self.assertEqual(json.loads((self.app / 'release.json').read_text())['commit'], A)
        self.assertEqual((self.root / 'app').resolve(), self.app)

    def test_directory_then_symlink_publish_preserves_old_assets_and_backend(self):
        first = self.publish()
        self.assertEqual(remote.frontend_commit(self.app), B)
        self.assertTrue(self.dist.is_symlink())
        self.assertEqual((self.dist / 'assets/old.js').read_text(), 'old')
        self.publish(C, B)
        self.assertEqual(remote.frontend_commit(self.app), C)
        self.assertEqual(first['backendCommit'], A)
        self.assert_data()

    def test_first_health_failure_restores_original_directory(self):
        def fail(_):
            raise RuntimeError('模拟页面验证失败')
        with self.assertRaises(RuntimeError):
            self.publish(healthcheck=fail)
        self.assertFalse(self.dist.is_symlink())
        self.assertEqual(remote.frontend_commit(self.app), A)
        self.assertEqual((self.dist / 'assets/old.js').read_text(), 'old')
        self.assertFalse((self.root / 'frontend-releases' / B).exists())
        self.assert_data()

    def test_later_health_failure_restores_previous_frontend(self):
        self.publish()
        def fail(_):
            raise RuntimeError('模拟页面验证失败')
        with self.assertRaises(RuntimeError):
            self.publish(C, B, fail)
        self.assertEqual(remote.frontend_commit(self.app), B)
        self.assertEqual((self.dist / 'assets/new.js').read_text(), B)
        self.assert_data()

    def test_stale_frontend_base_is_rejected(self):
        self.publish()
        with self.assertRaisesRegex(ValueError, '版本已变化'):
            self.publish(C, A)
        self.assertEqual(remote.frontend_commit(self.app), B)

    def test_manual_rollback_is_verified_and_cannot_override_later_publish(self):
        self.publish()
        backup = next((self.root / 'shared/backups').iterdir())
        remote.rollback(self.root, backup, lambda _: None)
        self.assertEqual(remote.frontend_commit(self.app), A)
        self.assertFalse(self.dist.is_symlink())
        self.assert_data()
        with self.assertRaisesRegex(ValueError, '当前版本已变化'):
            remote.rollback(self.root, backup, lambda _: None)

    def test_manual_rollback_rejects_changed_backup_files_and_version(self):
        self.publish()
        backup = next((self.root / 'shared/backups').iterdir())
        for name in ('index.html', 'assets/old.js'):
            path = backup / 'previous-dist' / name
            original = path.read_bytes()
            path.write_text('被修改的静态备份')
            with self.assertRaisesRegex(ValueError, '备份校验失败'):
                remote.rollback(self.root, backup, lambda _: None)
            self.assertEqual(remote.frontend_commit(self.app), B)
            path.write_bytes(original)
        record = json.loads((backup / 'manifest.json').read_text())
        record['previousFrontendCommit'] = C
        (backup / 'manifest.json').write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, '备份版本不一致'):
            remote.rollback(self.root, backup, lambda _: None)
        self.assertEqual(remote.frontend_commit(self.app), B)
        self.assert_data()

    def test_log_failure_restores_original_and_allows_same_commit_retry(self):
        with patch.object(remote, 'log_result', side_effect=OSError('模拟日志空间不足')):
            with self.assertRaisesRegex(OSError, '日志空间不足'):
                self.publish()
        self.assertFalse(self.dist.is_symlink())
        self.assertFalse((self.root / 'frontend-releases' / B).exists())
        self.assertEqual(remote.frontend_commit(self.app), A)
        self.publish()
        self.assertEqual(remote.frontend_commit(self.app), B)
        self.assert_data()

    def test_concurrent_full_release_lock_blocks_activation(self):
        archive, sha = self.bundle()
        with (self.root / 'deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                remote.publish(self.root, archive, B, sha, lambda _: None)
        self.assertFalse(self.dist.is_symlink())

    def test_bad_digest_and_private_path_are_rejected_before_switch(self):
        archive, sha = self.bundle()
        with self.assertRaisesRegex(ValueError, '校验和'):
            remote.publish(self.root, archive, B, '0' * 64, lambda _: None)
        archive, sha = self.bundle(extra={'source/desktop/.env': b'private'})
        with self.assertRaisesRegex(ValueError, '私有'):
            remote.publish(self.root, archive, B, sha, lambda _: None)
        self.assertFalse(self.dist.is_symlink())
        self.assert_data()


class ScopeTests(unittest.TestCase):
    def test_frontend_allowed_backend_change_rejected(self):
        with tempfile.TemporaryDirectory(prefix='vra-front-scope-') as directory:
            repo = Path(directory)
            def git(*args):
                return subprocess.check_output(['git', '-C', directory, *args], text=True).strip()
            def save():
                git('add', '.')
                git('-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', 'commit', '-qm', 'fixture')
                return git('rev-parse', 'HEAD')
            git('init', '-q')
            (repo / 'desktop').mkdir()
            (repo / 'orchestrator').mkdir()
            (repo / 'desktop/page.tsx').write_text('original')
            (repo / 'orchestrator/api.ts').write_text('original')
            base = save()
            (repo / 'desktop/page.tsx').write_text('new frontend')
            target = save()
            self.assertEqual(builder.check_scope(repo, base, base), target)
            (repo / 'orchestrator/api.ts').rename(repo / 'desktop/moved-api.ts')
            save()
            with self.assertRaisesRegex(ValueError, '前端范围外'):
                builder.check_scope(repo, base, base)
            (repo / 'desktop/moved-api.ts').rename(repo / 'orchestrator/api.ts')
            (repo / 'orchestrator/api.ts').write_text('backend changed')
            save()
            with self.assertRaisesRegex(ValueError, '前端范围外'):
                builder.check_scope(repo, base, base)


if __name__ == '__main__':
    unittest.main()
