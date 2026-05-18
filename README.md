# papyrus

Live-event map for San Francisco. FastAPI backend that fans out web search
across Tavily, extracts structured events with Claude, and geocodes via
Nominatim; React + Mapbox frontend renders them as markers.

## Running locally

Prereqs: Python 3.11+, Node 20+, [pnpm](https://pnpm.io/installation), and
three API keys.

### 1. Clone and set up env

```bash
git clone git@github.com:yiphei/papyrus.git
cd papyrus
cp .env.example .env
```

Fill in `.env`:

- `ANTHROPIC_API_KEY` — https://console.anthropic.com/settings/keys
- `TAVILY_API_KEY` — https://tavily.com (free tier is fine)
- `VITE_MAPBOX_TOKEN` — https://account.mapbox.com (default public token works)

### 2. Backend (Python)

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e .
```

### 3. Frontend (React + Vite)

```bash
pnpm install
```

### 4. Run, in two terminals

Terminal A — backend on `:8000`:

```bash
.venv/bin/uvicorn papyrus.api.main:app --host 127.0.0.1 --port 8000 --env-file .env --reload
```

Terminal B — frontend on `:5173`:

```bash
pnpm dev
```

Open **http://localhost:5173/**. First load is ~60s while the backend fans
out to Tavily + Claude + Nominatim. Subsequent calls within the same minute
hit an in-process cache and return instantly.

### Health check

```bash
curl 'http://127.0.0.1:8000/events?bbox=37.70,-122.52,37.83,-122.36&near=San+Francisco&limit=15'
```
should return a JSON `{"events": [...]}` payload.
