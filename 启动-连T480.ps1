# 本机只跑前端，后端 API 全部代理到 T480 的 Docker。
# 不启动 Docker Desktop、不跑本地 Python 后端，内存占用 = 一个 Vite 进程。
#
# 用法：
#   .\启动-连T480.ps1            # 默认走香港隧道（不在局域网时用）
#   .\启动-连T480.ps1 -Lan       # 在家/同局域网，直连 T480，更快
#
# 后端无需鉴权 key（本地 VLAN 内网信任）。浏览器打开即用。

param(
    [switch]$Lan  # 加 -Lan 走局域网 192.168.50.95；默认走香港隧道
)

$ErrorActionPreference = "Stop"

# 后端地址：局域网直连 vs 香港 frp 隧道
if ($Lan) {
    $env:VITE_API_URL = "http://192.168.50.95:8900"
    Write-Host "后端 = T480 局域网直连 ($($env:VITE_API_URL))" -ForegroundColor Cyan
} else {
    $env:VITE_API_URL = "http://43.129.217.225:8900"
    Write-Host "后端 = T480 经香港隧道 ($($env:VITE_API_URL))" -ForegroundColor Cyan
}

Set-Location "$PSScriptRoot\frontend"

Write-Host "启动本地前端 (Vite)... 就绪后浏览器打开 http://localhost:5899/" -ForegroundColor Green
Write-Host "（前端 Vite proxy /api → $($env:VITE_API_URL)）" -ForegroundColor Yellow
Write-Host ""
Write-Host "如需接入 AI（API key / 订阅 CLI），在网页「接入 AI」页配置" -ForegroundColor Gray
Write-Host ""

npm run dev
