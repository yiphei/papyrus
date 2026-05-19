dev:
    pnpm install
    pnpm dev

dev-test:
    pnpm install
    VITE_USE_STATIC_EVENTS=1 pnpm dev

be:
    uv run uvicorn papyrus.api.main:app --host 127.0.0.1 --port 8000 --env-file .env --reload
