#!/usr/bin/env bash
set -euo pipefail

show_usage() {
  cat <<'EOF'
Usage: ./scripts/collect_readme_context.sh [revision-range]

Collect Git context for README updates.

Examples:
  ./scripts/collect_readme_context.sh
  ./scripts/collect_readme_context.sh v1.2.7..HEAD
  ./scripts/collect_readme_context.sh main..feature/readme-sync
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  show_usage
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ]; then
  echo "Not inside a Git repository." >&2
  exit 1
fi

cd "$ROOT"

CURRENT_TAG=""
BASE_TAG=""
RANGE="${1:-}"

if CURRENT_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null)"; then
  :
else
  CURRENT_TAG=""
fi

if [ -n "$CURRENT_TAG" ]; then
  if BASE_TAG="$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null)"; then
    :
  else
    BASE_TAG=""
  fi
else
  if BASE_TAG="$(git describe --tags --abbrev=0 2>/dev/null)"; then
    :
  else
    BASE_TAG=""
  fi
fi

MODE="range"

if [ -z "$RANGE" ]; then
  if [ -n "$BASE_TAG" ]; then
    RANGE="${BASE_TAG}..HEAD"
  else
    FIRST_COMMIT="$(git rev-list --max-count=20 --reverse HEAD | head -n 1)"
    HEAD_COMMIT="$(git rev-parse HEAD)"
    if [ "$FIRST_COMMIT" = "$HEAD_COMMIT" ]; then
      MODE="single-commit"
      RANGE="$HEAD_COMMIT"
    else
      RANGE="${FIRST_COMMIT}..HEAD"
    fi
  fi
fi

print_section() {
  printf '## %s\n' "$1"
}

echo "Repository: $ROOT"
echo "Range: $RANGE"
if [ -n "$CURRENT_TAG" ]; then
  echo "Current tag at HEAD: $CURRENT_TAG"
fi
if [ -n "$BASE_TAG" ]; then
  echo "Base tag: $BASE_TAG"
fi
echo

print_section "Commits"
if [ "$MODE" = "single-commit" ]; then
  git log -1 --date=short --pretty='format:- %ad %h %s' "$RANGE"
else
  git log --no-merges --date=short --pretty='format:- %ad %h %s' "$RANGE"
fi
echo
echo

print_section "Changed Files"
if [ "$MODE" = "single-commit" ]; then
  git show --name-status --format='' "$RANGE"
else
  git diff --name-status "$RANGE"
fi
echo
echo

print_section "Likely User-Facing Paths"
if [ "$MODE" = "single-commit" ]; then
  git show --name-only --format='' "$RANGE" | rg '^(README\.md|CHANGELOG\.md|docs/|frontweb/|backend-node/|desktop/)' || echo "(no matching paths)"
else
  git diff --name-only "$RANGE" | rg '^(README\.md|CHANGELOG\.md|docs/|frontweb/|backend-node/|desktop/)' || echo "(no matching paths)"
fi
echo
echo

print_section "Feature-Oriented Commits"
FEATURE_GREP='feat|feature|新增|支持|优化|修复|画布|分镜|角色|场景|道具|视频|图片|README|readme|文档'
if [ "$MODE" = "single-commit" ]; then
  git log -1 --date=short --pretty='format:- %ad %h %s' "$RANGE" | rg -i "$FEATURE_GREP" || echo "(no matching commit subjects)"
else
  git log --no-merges --date=short --pretty='format:- %ad %h %s' --grep="$FEATURE_GREP" -i "$RANGE" || echo "(no matching commit subjects)"
fi
echo
echo

print_section "Diffstat"
if [ "$MODE" = "single-commit" ]; then
  git show --stat --format='' "$RANGE"
else
  git diff --stat "$RANGE"
fi
