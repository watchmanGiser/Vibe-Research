#!/usr/bin/env bash
set -euo pipefail
exec python3 - "$@" <<'PY'
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

base = (sys.argv[1] if len(sys.argv) > 1 else "https://soufly.cn/vibe-research").rstrip("/")
expected = sys.argv[2] if len(sys.argv) > 2 else ""
if expected and not re.fullmatch(r"[a-f0-9]{40}", expected):
    raise SystemExit("健康检查失败：提交号无效")

def request(path):
    try:
        with urllib.request.urlopen(base + path, timeout=5) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, b""

health = None
for _ in range(6):
    try:
        status, raw = request("/api/health")
        candidate = json.loads(raw)
        if status == 200 and candidate.get("ok") is True:
            health = candidate
            break
    except Exception:
        pass
    time.sleep(1)
if health is None:
    raise SystemExit("健康检查失败：公网探针不可用")
for path in ["/", "/api/runs", "/api/ledger?kind=position"]:
    status, _ = request(path)
    if status != 401:
        raise SystemExit("健康检查失败：私有页面或接口未要求站点认证")
status, public_page = request("/intel/dingtalk")
if status != 200 or b'id="root"' not in public_page:
    raise SystemExit("健康检查失败：公开钉钉页面不可用")
for path, schema, collection in [("/api/semi/dingtalk", 2, "opinions"), ("/api/semi/dingtalk?view=messages", 1, "messages")]:
    status, raw = request(path)
    try:
        feed = json.loads(raw)
    except (ValueError, TypeError):
        raise SystemExit("健康检查失败：公开消息接口返回无效内容")
    if status != 200 or feed.get("schemaVersion") != schema or not isinstance(feed.get(collection), list):
        raise SystemExit("健康检查失败：公开原文或总结不可用")
app = pathlib.Path("/opt/vibe-research/app")
html = (app / "desktop/dist/index.html").read_text()
if "/vibe-research/assets/" not in html:
    raise SystemExit("健康检查失败：前端资源子路径错误")
if expected:
    release = json.loads((app / "release.json").read_text())
    pid = subprocess.check_output(["systemctl", "show", "vibe-research.service", "-p", "MainPID", "--value"], text=True).strip()
    cwd = pathlib.Path(f"/proc/{pid}/cwd").resolve()
    if release.get("commit") != expected or str(cwd) != f"/opt/vibe-research/releases/{expected}":
        raise SystemExit("健康检查失败：运行版本不匹配")
    version = json.loads((app / "orchestrator/package.json").read_text())["version"]
    if health.get("version") != version:
        raise SystemExit("健康检查失败：API 版本不匹配")
print("健康检查通过：" + json.dumps({"ok": True, "version": health.get("version"), "private_routes": "authenticated", "public_dingtalk": "available"}, ensure_ascii=False))
PY
