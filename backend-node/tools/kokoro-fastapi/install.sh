#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNTIME_DIR="${KOKORO_RUNTIME_DIR:-$PROJECT_ROOT/.runtime/kokoro-fastapi}"
REPOSITORY="https://github.com/remsky/Kokoro-FastAPI.git"

if ! command -v uv >/dev/null 2>&1; then
  echo "缺少 uv，请先执行: brew install uv" >&2
  exit 1
fi

if ! command -v espeak-ng >/dev/null 2>&1; then
  echo "缺少 espeak-ng，请先执行: brew install espeak-ng" >&2
  exit 1
fi

mkdir -p "$(dirname "$RUNTIME_DIR")"
if [[ -d "$RUNTIME_DIR/.git" ]]; then
  echo "Kokoro-FastAPI 已安装: $RUNTIME_DIR"
  exit 0
fi

if [[ -e "$RUNTIME_DIR" ]]; then
  echo "安装目录已存在但不是 Git 仓库: $RUNTIME_DIR" >&2
  exit 1
fi

git clone --depth 1 "$REPOSITORY" "$RUNTIME_DIR"
echo "Kokoro-FastAPI 已下载: $RUNTIME_DIR"
echo "运行 npm run kokoro:start 完成依赖和模型安装并启动服务。"
