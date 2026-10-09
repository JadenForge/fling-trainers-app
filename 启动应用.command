#!/bin/bash
# 双击这个文件即可启动「风灵月影修改器合集」
# （在 Finder 里双击，会自动打开终端并运行）

cd "$(dirname "$0")" || exit 1

echo "正在启动 风灵月影修改器合集…"
echo

bash scripts/run-local.sh

# 应用关闭后保留窗口，方便看报错
echo
echo "应用已退出。按回车关闭此窗口。"
read -r _
