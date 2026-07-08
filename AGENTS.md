# AGENTS.md

## Cursor Cloud specific instructions

### Project Overview

LocalMiniDrama (本地短剧助手) — an AI-powered local short drama creation tool. Single product, three sub-projects sharing one repo (no monorepo tooling).

### Services

| Service | Directory | Port | Start Command |
|---------|-----------|------|---------------|
| Backend (Express + SQLite) | `backend-node/` | 5679 | `npm run dev` |
| Frontend (Vite + Vue 3) | `frontweb/` | 3013 | `npm run dev` |

Frontend proxies `/api` and `/static` to backend via Vite config.

### Running Tests

```bash
# Backend tests (Node.js built-in test runner)
cd backend-node && node --test test/*.test.js

# Frontend tests (ESM, Node.js built-in test runner)
cd frontweb && node --test test/*.test.js
```

No ESLint or other lint tool is configured in this codebase.

### Building

```bash
cd frontweb && npm run build
```

### Key Development Notes

- Pure JavaScript (no TypeScript) throughout.
- Backend uses `node --watch` for hot reloading in dev mode (`npm run dev`).
- Database is SQLite (embedded via `better-sqlite3`), auto-created in `backend-node/data/`.
- Migrations run automatically on backend startup (`ensureColumns()`); explicit `npm run migrate` only needed for first-time setup or after adding new migration SQL files.
- Config file at `backend-node/configs/config.yaml` already exists in the repo — no need to copy from example.
- AI content generation requires external API keys (configured via the app's "AI 配置" page), but the app fully functions without them for development/testing purposes.
- Codex-only image generation workflow is documented in `docs/codex-image-workflow.md`; read it before changing Codex image queue, candidate import, character/prop/scene image buttons, or storyboard main/first/last frame buttons.
- The backend also serves the built frontend from `frontweb/dist/` at port 5679 when the dist folder exists; during development, use the Vite dev server at port 3013 instead.

### README Update Agent

- When the user explicitly asks to `更新 README.md`、`同步 README`、`补充 README 功能说明` or similar, first read `codex-skills/update-readme-from-git/SKILL.md` and follow that workflow.
- Before editing, run `codex-skills/update-readme-from-git/scripts/collect_readme_context.sh [revision-range]` to collect the relevant Git commits, changed files, and diffstat.
- Default scope is the root `README.md` only. Do not update `docs/en.md`, child-package README files, or `CHANGELOG.md` unless the user explicitly asks for those files too.
