#!/usr/bin/env bash
# FFmpeg 命令生成器 - macOS / Linux 启动脚本
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装：https://nodejs.org/"
  exit 1
fi

echo "============================================"
echo " FFmpeg 命令生成器 - 正在启动本地服务"
echo "============================================"
echo "访问地址： http://127.0.0.1:8787"
echo "按 Ctrl+C 停止服务"
echo

exec node server.js
