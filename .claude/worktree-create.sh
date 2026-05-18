#!/bin/bash
set -euo pipefail

# Claude Code WorktreeCreate hook.
# Creates a new git worktree and copies .env into it.
#
# Base ref selection (via WORKTREE_BASE env var):
#   (unset)                     -> origin/main
#   WORKTREE_BASE=current       -> HEAD of $CLAUDE_PROJECT_DIR (the branch claude was launched from)
#   WORKTREE_BASE=<ref>         -> any branch/tag/SHA

INPUT=$(cat)
WORKTREE_NAME=$(echo "$INPUT" | jq -r '.name')
CWD=$(echo "$INPUT" | jq -r '.cwd')

if [ "${WORKTREE_BASE:-}" = "current" ]; then
    BASE_REF="$(git -C "$CLAUDE_PROJECT_DIR" rev-parse HEAD)"
elif [ -n "${WORKTREE_BASE:-}" ]; then
    BASE_REF="$WORKTREE_BASE"
else
    BASE_REF="origin/main"
fi

WORKTREE_PATH="$CWD/.claude/worktrees/$WORKTREE_NAME"
BRANCH_NAME="worktree-$WORKTREE_NAME"
mkdir -p "$CWD/.claude/worktrees"
git -C "$CWD" branch -D "$BRANCH_NAME" >/dev/null 2>&1 || true
git -C "$CWD" worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" "$BASE_REF" >/dev/null

[ -f "$CWD/.env" ] && cp "$CWD/.env" "$WORKTREE_PATH/.env"

echo "$WORKTREE_PATH"
