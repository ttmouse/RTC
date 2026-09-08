#!/bin/bash
# 启动 Node.js 后端服务器（HTTP + WebSocket 代理）
# 解决 file:// 下麦克风权限受限问题

cd "$(dirname "$0")"

# 先杀掉旧进程
kill $(lsof -ti:8931 2>/dev/null) 2>/dev/null
sleep 0.3

# 启动 Node.js 服务
node server.js &
SERVER_PID=$!
sleep 0.5
open http://localhost:8931
wait $SERVER_PID