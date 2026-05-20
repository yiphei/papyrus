# papyrus

Live-event map for San Francisco. React + Mapbox frontend that renders a
curated set of events as markers. A FastAPI backend (Tavily + Claude +
Nominatim) is included for regenerating the static event list, but is not
required to run the app.

## Running locally

Prereqs: Node 20+, [pnpm](https://pnpm.io/installation), and a Mapbox token.

### 1. Clone and set up env

```bash
git clone git@github.com:yiphei/papyrus.git
cd papyrus
cp .env.example .env
```

Fill in `.env`:

- `VITE_MAPBOX_TOKEN` — https://account.mapbox.com (default public token works)

### 2. Run the frontend

```bash
just dev
```

Open **http://localhost:5173/**. Events are loaded from
`src/events.static.json`, so the first load is instant.

## Optional: regenerating `events.static.json`

The repo also ships a FastAPI backend that fans out web search across
Tavily, extracts structured events with Claude, and geocodes via
Nominatim. Use it when you want to refresh the static event list.

Extra prereqs: [uv](https://docs.astral.sh/uv/getting-started/installation/),
plus `ANTHROPIC_API_KEY` and `TAVILY_API_KEY` in `.env`.

```bash
uv sync
just be   # serves http://127.0.0.1:8000
```

Health check:

```bash
curl 'http://127.0.0.1:8000/events?bbox=37.70,-122.52,37.83,-122.36&near=San+Francisco&limit=15'
```

should return a JSON `{"events": [...]}` payload.

### Optional: auto-activate the Python venv with direnv

So you can run `python ...` / `pytest` / `ruff` directly instead of prefixing
with `uv run`. A repo-tracked `.envrc` activates `.venv` on `cd` in.

1. Install direnv: `brew install direnv` (or your package manager).
2. Hook it into your shell — add to `~/.zshrc` (or `~/.bashrc`):
   ```bash
   eval "$(direnv hook zsh)"
   ```
3. From the repo root, run `direnv allow` once (direnv won't load untrusted
   `.envrc` files automatically).

Requires `.venv` to exist — run `uv sync` first.
