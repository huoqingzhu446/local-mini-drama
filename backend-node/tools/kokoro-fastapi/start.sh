#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNTIME_DIR="${KOKORO_RUNTIME_DIR:-$PROJECT_ROOT/.runtime/kokoro-fastapi}"

if [[ ! -x "$RUNTIME_DIR/start-gpu_mac.sh" ]]; then
  echo "Kokoro-FastAPI 尚未安装，请先运行 npm run kokoro:install" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "缺少 uv，请先执行: brew install uv" >&2
  exit 1
fi

if ! command -v espeak-ng >/dev/null 2>&1; then
  echo "缺少 espeak-ng，请先执行: brew install espeak-ng" >&2
  exit 1
fi

cd "$RUNTIME_DIR"

if [[ ! -x .venv/bin/python ]]; then
  uv venv --python 3.10
fi

INSTALL_OK=false
for ATTEMPT in 1 2 3 4 5 6 7 8; do
  echo "安装 Kokoro Python 依赖（第 $ATTEMPT/8 次尝试）"
  if UV_HTTP_RETRIES=10 UV_HTTP_TIMEOUT=120 uv pip install \
    --python .venv/bin/python \
    --constraint "$SCRIPT_DIR/constraints.txt" \
    -e .; then
    INSTALL_OK=true
    break
  fi
  sleep 3
done
if [[ "$INSTALL_OK" != true ]]; then
  echo "Kokoro Python 依赖安装失败，请检查网络后重试。" >&2
  exit 1
fi

MODEL_DIR="$RUNTIME_DIR/api/src/models/v1_0"
MODEL_PATH="$MODEL_DIR/kokoro-v1_0.pth"
MODEL_URL="${KOKORO_MODEL_URL:-https://hf-mirror.com/hexgrad/Kokoro-82M/resolve/main/kokoro-v1_0.pth}"
EXPECTED_MODEL_BYTES=327212226
EXPECTED_MODEL_SHA256=496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4
mkdir -p "$MODEL_DIR"

CURRENT_MODEL_BYTES=0
if [[ -f "$MODEL_PATH" ]]; then
  CURRENT_MODEL_BYTES="$(stat -f '%z' "$MODEL_PATH")"
fi
if (( CURRENT_MODEL_BYTES < EXPECTED_MODEL_BYTES )); then
  echo "正在续传 Kokoro 模型: $CURRENT_MODEL_BYTES / $EXPECTED_MODEL_BYTES bytes"
  curl --location --fail --retry 20 --retry-all-errors --retry-delay 2 \
    --continue-at - --output "$MODEL_PATH" "$MODEL_URL"
fi

FINAL_MODEL_BYTES="$(stat -f '%z' "$MODEL_PATH")"
if (( FINAL_MODEL_BYTES != EXPECTED_MODEL_BYTES )); then
  echo "Kokoro 模型大小异常: $FINAL_MODEL_BYTES（预期 $EXPECTED_MODEL_BYTES）" >&2
  exit 1
fi
FINAL_MODEL_SHA256="$(shasum -a 256 "$MODEL_PATH" | awk '{print $1}')"
if [[ "$FINAL_MODEL_SHA256" != "$EXPECTED_MODEL_SHA256" ]]; then
  echo "Kokoro 模型校验失败: $FINAL_MODEL_SHA256" >&2
  exit 1
fi

export USE_GPU=true
export USE_ONNX=false
export PYTHONPATH="$RUNTIME_DIR:$RUNTIME_DIR/api"
export MODEL_DIR=src/models
export VOICES_DIR=src/voices/v1_0
export WEB_PLAYER_PATH="$RUNTIME_DIR/web"
export DEVICE_TYPE=mps
export PYTORCH_ENABLE_MPS_FALLBACK=1

exec uv run --no-sync uvicorn api.src.main:app --host 127.0.0.1 --port 8880
