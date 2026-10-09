#!/bin/bash
# 本地启动脚本
#
# 正常情况下直接 `npm start` 即可；这个脚本额外处理了两种环境：
#   1. 在 WorkBuddy 沙箱里，会注入 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，导致 Electron 起不来；
#   2. 沙箱禁用了 Chromium 沙箱与 GPU，需要补上启动参数。
# 两种处理对普通环境都无副作用。
#
# 注意：macOS 自带的 bash 是 3.2，在 `set -u` 下对「空数组」用 "${ARR[@]}" 会报
# unbound variable。所以这里用 ARGS 数组，并保证它至少有一个元素。

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

APP_DIR="$PWD"

# 1) 清掉会干扰 Electron 的环境变量
unset ELECTRON_RUN_AS_NODE 2>/dev/null || true
unset NODE_OPTIONS 2>/dev/null || true

# 2) 找到 Electron 可执行文件
ELECTRON_BIN=""
for candidate in \
  "$APP_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
  "$APP_DIR/node_modules/electron/dist/electron" \
  "$APP_DIR/node_modules/.bin/electron"
do
  if [ -x "$candidate" ]; then
    ELECTRON_BIN="$candidate"
    break
  fi
done

if [ -z "$ELECTRON_BIN" ]; then
  echo "找不到 Electron，请先在项目目录执行： npm install" >&2
  exit 1
fi

# 3) 数据不存在时先抓一份
if [ ! -f "$APP_DIR/data/trainers.json" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "缺少 Node.js，无法生成数据文件。请先安装 Node.js。" >&2
    exit 1
  fi
  echo "尚未生成修改器数据，先抓取一次（约 1-3 分钟）…"
  node "$APP_DIR/scripts/build-data.mjs"
fi

# 4) 组装参数：始终以 APP_DIR 打头，保证数组非空
ARGS=("$APP_DIR")

# 沙箱 / 无 GPU 环境的兜底参数
if [ -n "${CODEBUDDY_SANDBOX_BROKER_IPC_ADDRESS:-}" ] || [ -n "${WORKBUDDY_NODE_ENV:-}" ]; then
  ARGS+=(--no-sandbox --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage)
fi

# 透传调用方额外参数，例如 --smoke
if [ "$#" -gt 0 ]; then
  ARGS+=("$@")
fi

echo "启动：$ELECTRON_BIN"
exec "$ELECTRON_BIN" "${ARGS[@]}"
