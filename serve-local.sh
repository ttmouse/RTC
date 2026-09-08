#!/bin/bash
# 启动 RTC 完整链路（本地 SenseVoice 引擎）
# 先起 asr_local（ws://127.0.0.1:8932），再起 node server.js（HTTP + WS 代理 :8931）

cd "$(dirname "$0")"

# 先杀掉旧进程
kill $(lsof -ti:8931 2>/dev/null) 2>/dev/null
kill $(lsof -ti:8932 2>/dev/null) 2>/dev/null
sleep 0.3

# 启动本地 SenseVoice ASR 服务（-u 关闭 stdout 缓冲，nohup 防终端关闭被杀）
echo "[serve] 启动本地 SenseVoice ASR..."
nohup python3 -u asr_local/server.py > /tmp/asr_local.log 2>&1 &
LOCAL_PID=$!

# 等待端口就绪（模型加载约 2~3 秒）
READY=0
for i in $(seq 1 30); do
  if lsof -ti:8932 >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

if [ $READY -ne 1 ]; then
  echo "[serve] ❌ 本地 ASR 启动失败，日志如下："
  cat /tmp/asr_local.log
  exit 1
fi
echo "[serve] ✅ 本地 ASR 就绪 (ws://127.0.0.1:8932)"

# 启动 Node.js 代理
echo "[serve] 启动 Node.js 代理 :8931"
node server.js &
SERVER_PID=$!
sleep 0.5
open http://localhost:8931

trap "kill $LOCAL_PID $SERVER_PID 2>/dev/null" EXIT
wait $SERVER_PID
