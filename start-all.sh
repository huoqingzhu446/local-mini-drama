#!/usr/bin/env bash
set -u

RESTART_APP=1
if [[ "${1:-}" == "--keep-running" ]]; then
  RESTART_APP=0
elif [[ -n "${1:-}" && "${1:-}" != "--restart" ]]; then
  echo "用法：./start-all.sh [--restart|--keep-running]" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
LOG_DIR="$RUNTIME_DIR/logs"
PID_DIR="$RUNTIME_DIR/pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

if ! command -v curl >/dev/null 2>&1; then
  echo "启动失败：系统缺少 curl。" >&2
  exit 1
fi

node_works() {
  local candidate="$1"
  [[ -x "$candidate" ]] || return 1
  (
    cd "$ROOT_DIR/backend-node" || exit 1
    "$candidate" -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close()"
  ) >/dev/null 2>&1
}

select_node() {
  local candidate=""
  local configured="${LOCAL_MINI_DRAMA_NODE:-}"
  local current=""
  current="$(command -v node 2>/dev/null || true)"

  for candidate in \
    "$configured" \
    "$current" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"; do
    [[ -n "$candidate" ]] || continue
    if node_works "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  # Native modules are tied to Node's module ABI. Search every installed NVM
  # runtime instead of assuming that the dependency was installed with Node 22.
  for candidate in "$HOME"/.nvm/versions/node/v*/bin/node; do
    [[ -e "$candidate" ]] || continue
    if node_works "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(select_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "启动失败：已安装的 Node.js 均无法加载 better-sqlite3。" >&2
  echo "请使用安装后端依赖时的 Node.js，或在 backend-node 目录重新运行 npm install。" >&2
  echo "也可通过 LOCAL_MINI_DRAMA_NODE 指定 Node.js 可执行文件。" >&2
  exit 1
fi

VITE_BIN="$ROOT_DIR/frontweb/node_modules/vite/bin/vite.js"
if [[ ! -f "$VITE_BIN" ]]; then
  echo "启动失败：前端依赖不存在，请先在 frontweb 目录运行 npm install。" >&2
  exit 1
fi

if [[ ! -x "$ROOT_DIR/backend-node/tools/kokoro-fastapi/start.sh" ]]; then
  echo "启动失败：Kokoro 启动脚本不存在或不可执行。" >&2
  exit 1
fi

is_ready() {
  curl --fail --silent --show-error --max-time 2 "$1" >/dev/null 2>&1
}

process_cwd() {
  local pid="$1"
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ { sub(/^n/, ""); print; exit }'
}

stop_project_service() {
  local name="$1"
  local port="$2"
  local expected_cwd="$3"
  local pid=""
  local cwd=""
  local stopped=0

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    cwd="$(process_cwd "$pid")"
    if [[ "$cwd" != "$expected_cwd" ]]; then
      echo "✗ 端口 ${port} 被其它目录的进程占用（PID ${pid}，${cwd}），未自动停止。" >&2
      return 1
    fi
    echo "→ 正在停止旧的 ${name}（PID ${pid}）"
    kill "$pid" 2>/dev/null || true
    stopped=1
  done < <(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)

  if (( stopped == 0 )); then
    return 0
  fi

  local attempt=0
  while (( attempt < 24 )); do
    if ! lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
    attempt=$((attempt + 1))
  done
  echo "✗ 旧的 ${name} 未能在 6 秒内退出，请手动检查端口 ${port}。" >&2
  return 1
}

start_background() {
  local name="$1"
  local workdir="$2"
  shift 2
  (
    cd "$workdir" || exit 1
    nohup "$@" >"$LOG_DIR/$name.log" 2>&1 </dev/null &
    echo "$!" >"$PID_DIR/$name.pid"
  )
}

wait_for_service() {
  local name="$1"
  local url="$2"
  local timeout="$3"
  local elapsed=0
  while (( elapsed < timeout )); do
    if is_ready "$url"; then
      echo "✓ $name 已就绪"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "✗ $name 启动超时，日志：$LOG_DIR/$name.log" >&2
  tail -n 20 "$LOG_DIR/$name.log" >&2 2>/dev/null || true
  return 1
}

WAIT_NAMES=()
WAIT_URLS=()
WAIT_TIMEOUTS=()

ensure_service() {
  local name="$1"
  local workdir="$2"
  local url="$3"
  local timeout="$4"
  shift 4

  if is_ready "$url"; then
    echo "✓ $name 已在运行"
    return 0
  fi

  echo "→ 正在启动 $name"
  start_background "$name" "$workdir" "$@"
  WAIT_NAMES+=("$name")
  WAIT_URLS+=("$url")
  WAIT_TIMEOUTS+=("$timeout")
}

echo "使用 Node：$NODE_BIN ($("$NODE_BIN" -v))"

if (( RESTART_APP == 1 )); then
  echo "本次启动会刷新项目后端和前端，确保加载当前工作区代码。"
  stop_project_service "前端" 3013 "$ROOT_DIR/frontweb" || exit 1
  stop_project_service "后端" 5679 "$ROOT_DIR/backend-node" || exit 1
else
  echo "使用 --keep-running：健康的现有服务不会重启。"
fi

ensure_service \
  "kokoro" \
  "$ROOT_DIR/backend-node" \
  "http://127.0.0.1:8880/v1/audio/voices" \
  180 \
  bash "$ROOT_DIR/backend-node/tools/kokoro-fastapi/start.sh"

ensure_service \
  "backend" \
  "$ROOT_DIR/backend-node" \
  "http://127.0.0.1:5679/health" \
  60 \
  "$NODE_BIN" src/server.js

ensure_service \
  "frontend" \
  "$ROOT_DIR/frontweb" \
  "http://127.0.0.1:3013/" \
  60 \
  "$NODE_BIN" "$VITE_BIN"

FAILED=0
INDEX=0
while (( INDEX < ${#WAIT_NAMES[@]} )); do
  wait_for_service "${WAIT_NAMES[$INDEX]}" "${WAIT_URLS[$INDEX]}" "${WAIT_TIMEOUTS[$INDEX]}" || FAILED=1
  INDEX=$((INDEX + 1))
done

if (( FAILED != 0 )); then
  echo "部分服务启动失败，请根据上方日志路径检查。" >&2
  exit 1
fi

echo
echo "全部服务已启动："
echo "  前端：  http://localhost:3013"
echo "  后端：  http://localhost:5679"
echo "  Kokoro：http://localhost:8880/web/"
echo "  日志：  $LOG_DIR"
