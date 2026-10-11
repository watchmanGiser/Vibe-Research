#!/usr/bin/env python3
"""一致性数据快照与保留升级后数据的回滚。由已停止写入的发布流程调用。"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil


def inventory(root: Path) -> dict:
    files = {}
    for base, dirs, names in os.walk(root, followlinks=False):
        for name in dirs[:]:
            p = Path(base) / name
            if p.is_symlink():
                files[str(p.relative_to(root))] = {"link": os.readlink(p)}
                dirs.remove(name)
        for name in names:
            p = Path(base) / name
            rel = str(p.relative_to(root))
            if p.is_symlink():
                files[rel] = {"link": os.readlink(p)}
            else:
                digest = hashlib.sha256()
                with p.open("rb") as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(block)
                files[rel] = {"sha256": digest.hexdigest(), "bytes": p.stat().st_size}
    return files


def capture(root: Path, commit: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("无效提交号")
    data = root / "shared" / ".local"
    if data.is_symlink() or not data.is_dir():
        raise ValueError("数据根必须是独立目录")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = root / "backups" / f"pre-v210-{stamp}-{commit[:12]}"
    backup.mkdir(mode=0o700, parents=True)
    before = inventory(data)
    size = sum(v.get("bytes", 0) for v in before.values())
    if shutil.disk_usage(root).free < size + 512 * 1024 * 1024:
        raise RuntimeError("磁盘不足以保留独立数据快照")
    copied = backup / ".local"
    shutil.copytree(data, copied, symlinks=True)
    # copytree 保留权限但不保留属主；发布以 root 执行，恢复后仍需服务用户可读写。
    for base, dirs, names in os.walk(data, followlinks=False):
        rel = Path(base).relative_to(data)
        for source in [Path(base), *[Path(base) / name for name in dirs + names]]:
            destination = copied / source.relative_to(data)
            stat = source.lstat()
            os.chown(destination, stat.st_uid, stat.st_gid, follow_symlinks=False)
    after = inventory(data)
    if before != after or before != inventory(backup / ".local"):
        raise RuntimeError("快照期间数据变化或副本校验失败")
    manifest = {"created_at": stamp, "target_commit": commit,
                "previous_release": str((root / "current").resolve()),
                "files": before, "bytes": size}
    (backup / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False))
    (backup / "manifest.json").chmod(0o600)
    return backup


def restore(root: Path, backup: Path) -> Path:
    expected_parent = (root / "backups").resolve()
    if backup.is_symlink() or backup.resolve().parent != expected_parent:
        raise ValueError("快照不在受控备份目录")
    manifest = json.loads((backup / "manifest.json").read_text())
    saved = backup / ".local"
    if saved.is_symlink() or not saved.is_dir() or inventory(saved) != manifest["files"]:
        raise RuntimeError("快照缺失或校验失败")
    shared = root / "shared"
    data = shared / ".local"
    if data.is_symlink() or not data.is_dir():
        raise ValueError("数据根必须是独立目录")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    retained = shared / f".local-post-upgrade-{stamp}"
    # 两份目录都保留；不删除、不覆盖任何已有数据。
    data.rename(retained)
    try:
        saved.rename(data)
    except Exception:
        retained.rename(data)
        raise
    if inventory(data) != manifest["files"]:
        raise RuntimeError("恢复后数据校验失败")
    manifest["restored_at"] = stamp
    manifest["retained_upgrade_data"] = str(retained)
    (backup / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False))
    return retained


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["capture", "restore"])
    parser.add_argument("--root", type=Path, default=Path("/opt/vibe-research"))
    parser.add_argument("--commit")
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    if args.action == "capture":
        print(capture(root, args.commit or ""))
    elif args.backup is None:
        parser.error("restore 必须指定 --backup")
    else:
        print(restore(root, args.backup))


if __name__ == "__main__":
    main()
