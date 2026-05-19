dev:
    uv sync
    pnpm install
    pnpm dev

backend:
    uv run uvicorn papyrus.api.main:app --host 127.0.0.1 --port 8000 --env-file .env --reload
