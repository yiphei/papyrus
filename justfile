dev:
    pnpm install
    pnpm dev

be:
    uv run uvicorn papyrus.api.main:app --host 127.0.0.1 --port 8000 --env-file .env --reload

delete-cw:
    #!/usr/bin/env bash
    set -euo pipefail
    git worktree list --porcelain | awk '/^worktree / {print $2}' | grep '/\.claude/worktrees/' | while read -r wt; do
        echo "Removing $wt"
        git worktree remove --force "$wt"
    done
