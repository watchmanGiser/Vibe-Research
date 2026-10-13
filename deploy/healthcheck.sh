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
import urllib.parse
import urllib.request

base = (sys.argv[1] if len(sys.argv) > 1 else "https://soufly.cn/vibe-research").rstrip("/")
expected = sys.argv[2] if len(sys.argv) > 2 else ""
if expected and not re.fullmatch(r"[a-f0-9]{40}", expected):
    raise SystemExit("健康检查失败：提交号无效")

def request(path, referer=None):
    url = path if path.startswith(("https://", "http://")) else base + path
    req = urllib.request.Request(url, headers={"Referer": referer} if referer else {})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
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
for path in ["/", "/intel/semi", "/intel/jianfang", "/intel/dingtalk", "/intel/investment-news", "/my-stocks", "/notes", "/settings"]:
    status, public_page = request(path)
    if status != 200 or b'id="root"' not in public_page:
        raise SystemExit("健康检查失败：免登录页面不可用 " + path)
for path in ["/api/runs", "/api/ledger?kind=position", "/api/ledger?kind=watch", "/api/ledger?kind=note"]:
    status, raw = request(path, referer=base + "/intel/dingtalk")
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        raise SystemExit("健康检查失败：工作台接口返回无效内容 " + path)
    if status != 200 or not isinstance(payload, (dict, list)):
        raise SystemExit("健康检查失败：工作台接口仍被登录限制 " + path)
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
standalone = app / "desktop/dist/dingtalk.html"
if not standalone.is_file() or 'data-page="dingtalk-standalone"' not in standalone.read_text():
    raise SystemExit("健康检查失败：独立情报页产物缺失")
origin = urllib.parse.urlsplit(base)
status, standalone_page = request(urllib.parse.urlunsplit((origin.scheme, origin.netloc, "/dingtalk/", "", "")))
if status != 200 or b'data-page="dingtalk-standalone"' not in standalone_page:
    raise SystemExit("健康检查失败：独立情报页不可用")
if expected:
    release = json.loads((app / "release.json").read_text())
    pid = subprocess.check_output(["systemctl", "show", "vibe-research.service", "-p", "MainPID", "--value"], text=True).strip()
    cwd = pathlib.Path(f"/proc/{pid}/cwd").resolve()
    if release.get("commit") != expected or str(cwd) != f"/opt/vibe-research/releases/{expected}":
        raise SystemExit("健康检查失败：运行版本不匹配")
    version = json.loads((app / "orchestrator/package.json").read_text())["version"]
    if health.get("version") != version:
        raise SystemExit("健康检查失败：API 版本不匹配")
print("健康检查通过：" + json.dumps({"ok": True, "version": health.get("version"), "workspace": "available_without_login", "public_dingtalk": "available", "standalone_dingtalk": "available"}, ensure_ascii=False))
PY
