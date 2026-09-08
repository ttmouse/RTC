#!/bin/bash
# 启动 rtc-transcriber Qwen3-ASR 对比链路（不影响现有 SenseVoice 使用）
# 独立端口：
#   asr_local (Qwen3-ASR): ws://127.0.0.1:8933
#   node server.js       : http://localhost:8934 (engine=local → 8933)
#
# 与正式链路（8931/8932 SenseVoice）完全隔离，可同时运行对比效果。
# 页面里的引擎选择器仍选「本地引擎」，实际连到的会是 Qwen3-ASR。

cd "$(dirname "$0")"

# 杀掉旧的 Qwen3 测试进程（只杀 8933/8934）
kill $(lsof -ti:8933 2>/dev/null) 2>/dev/null
kill $(lsof -ti:8934 2>/dev/null) 2>/dev/null
sleep 0.3

# 启动 Qwen3-ASR 服务（模型较大，加载约 10~30 秒）
echo "[serve-qwen3] 启动 Qwen3-ASR (ws://127.0.0.1:8933)..."
ASR_PORT=8933 ASR_ENGINE=qwen3 nohup python3 -u asr_local/server.py > /tmp/asr_qwen3.log 2>&1 &
LOCAL_PID=$!

READY=0
for i in $(seq 1 90); do
  if lsof -ti:8933 >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

if [ $READY -ne 1 ]; then
  echo "[serve-qwen3] ❌ Qwen3-ASR 启动失败，日志如下："
  cat /tmp/asr_qwen3.log
  exit 1
fi
echo "[serve-qwen3] ✅ Qwen3-ASR 就绪"

# 启动 Node.js 代理（独立端口 8934，本地引擎指向 8933）
echo "[serve-qwen3] 启动 Node.js 代理 :8934"
PORT=8934 LOCAL_ASR_URL=ws://127.0.0.1:8933 node server.js &
SERVER_PID=$!
sleep 0.5
open http://localhost:8934

trap "kill $LOCAL_PID $SERVER_PID 2>/dev/null" EXIT
wait $SERVER_PID
