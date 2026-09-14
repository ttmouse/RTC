#!/bin/bash
# 放置 Qwen3-ASR 模型到约定目录（供 .app 桌面版外置模型使用）
#
# 用法:
#   ./scripts/setup-qwen3-model.sh                 # 从项目 asr_local 拷贝到约定目录
#   ./scripts/setup-qwen3-model.sh <源目录>        # 从指定目录拷贝
#
# 约定目录: ~/Library/Application Support/com.rtc.transcriber/models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25
# 可用环境变量 QWEN3_MODEL_DIR 覆盖目标位置
#
# 目录名必须与 asr_local/server.py 的 default_qwen3_dir() 一致（com.rtc.transcriber）。
# 这里以前写的是 rtc-transcriber，模型会被拷到一个应用中永远不会读的位置：
# 脚本打印「✅ 已放置」，桌面版却依然报「Qwen3 模型目录不存在」。
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${1:-asr_local/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25}"
DEST="${QWEN3_MODEL_DIR:-$HOME/Library/Application Support/com.rtc.transcriber/models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25}"

# 校验源目录完整
for f in conv_frontend.onnx encoder.int8.onnx decoder.int8.onnx; do
  if [ ! -f "$SRC/$f" ]; then
    echo "❌ 源目录缺少 $f: $SRC" >&2
    exit 1
  fi
done
if [ ! -d "$SRC/tokenizer" ]; then
  echo "❌ 源目录缺少 tokenizer: $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
cp "$SRC/conv_frontend.onnx" "$SRC/encoder.int8.onnx" "$SRC/decoder.int8.onnx" "$DEST/"
cp -R "$SRC/tokenizer" "$DEST/"

echo "✅ Qwen3 模型已放置到: $DEST"
du -sh "$DEST"
