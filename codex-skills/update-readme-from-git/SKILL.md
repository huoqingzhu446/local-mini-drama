---
name: update-readme-from-git
description: Refresh a repository `README.md` from recent Git commits, Git diff, and changelog context. Use when the user explicitly asks to update `README.md`, sync README feature sections, extract documentation updates from commits, or add/remove documented capabilities to match implemented product changes.
---

# Update Readme From Git

## Overview

Update `README.md` from implemented changes instead of guessing. Derive candidate updates from Git history first, then confirm them against touched code and existing docs before editing.

## Workflow

1. Stay at the repository root.
2. Run `./scripts/collect_readme_context.sh [revision-range]` to gather the commit range, recent commits, changed files, likely user-facing paths, and diffstat.
3. Read the current `README.md`.
4. Cross-check the Git summary against the touched product files and `CHANGELOG.md` when present.
5. Edit only the README sections supported by the implemented changes.
6. Re-read the edited sections and ensure each added or removed statement maps back to Git evidence.

## Decide The Commit Range

- Use the user-provided revision range if one was given.
- Otherwise prefer the range suggested by `collect_readme_context.sh`.
- If the README update is clearly tied to one feature branch, one release, or one commit, narrow the range before editing.
- If the selected range contains no user-facing change, do not force a README edit. Say so explicitly.

## Decide What Belongs In README

- Keep user-facing and contributor-relevant changes:
  - new features
  - removed or renamed capabilities
  - workflow changes
  - supported provider changes
  - setup, packaging, or service-layout changes that affect usage
- Skip internal-only changes unless they change documented behavior:
  - refactors
  - cleanup
  - tests
  - formatting
  - dependency churn
- Do not invent version numbers, release names, or marketing claims.
- Do not describe a feature as supported unless the code or changelog confirms it.
- Preserve the existing README tone, section hierarchy, and badge layout unless the user asked for a restructure.

## Project-Specific Focus For LocalMiniDrama

Check these sections first in this repository:

- `README.md` top banner and version block when the release version or positioning changed
- `README.md` "最新动态" for fresh highlights worth surfacing
- `README.md` "核心功能" and "画布工作流" for workflow or capability changes
- `README.md` "Codex 生图辅助模式" when commits touch Codex queueing, candidate import, or related buttons
- `README.md` quick start, AI provider, or architecture sections when ports, startup flow, packaging, or supported providers changed

Read `docs/codex-image-workflow.md` before changing Codex image queue wording or button descriptions.

Only change other docs such as `docs/en.md`, `backend-node/README.md`, `frontweb/README.md`, or `CHANGELOG.md` if the user explicitly expands the scope.

## Editing Rules

- Prefer concrete wording over vague upgrade language.
- Remove stale feature bullets when the implementation no longer supports them.
- Update nearby examples, button names, and section labels if the UI wording changed.
- Keep edits tight. Do not rewrite unrelated sections just because they can be polished.

## Final Check

- Report the commit range used.
- Mention which README sections changed.
- If no README-worthy change exists, explain that instead of making a no-op edit.
