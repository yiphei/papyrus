"""Diagnostic probes for Claude web_search + structured outputs.

Run with: .venv/bin/python scripts/probe_web_search.py
Env: ANTHROPIC_API_KEY must be set.
"""
from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass

import anthropic
from pydantic import BaseModel


MODEL = os.environ.get("PAPYRUS_LLM_MODEL", "claude-sonnet-4-6")


def _summarise(response) -> str:
    parts = []
    for b in getattr(response, "content", []):
        t = getattr(b, "type", "?")
        if t == "text":
            txt = getattr(b, "text", "") or ""
            parts.append(f"text({len(txt)}b): {txt[:120]!r}")
        elif t == "server_tool_use":
            parts.append(f"server_tool_use({getattr(b, 'name', '?')})")
        elif t == "web_search_tool_result":
            r = getattr(b, "content", None)
            n = len(r) if isinstance(r, list) else "?"
            parts.append(f"web_search_result(n={n})")
        else:
            parts.append(t)
    return " | ".join(parts) or "<empty>"


@dataclass
class Probe:
    name: str
    builder: callable

    def run(self, client) -> None:
        print(f"\n=== {self.name} ===", flush=True)
        t0 = time.monotonic()
        try:
            resp = self.builder(client)
        except Exception as exc:  # noqa: BLE001
            print(f"FAILED in {time.monotonic()-t0:.1f}s: {type(exc).__name__}: {exc}")
            return
        dt = time.monotonic() - t0
        stop = getattr(resp, "stop_reason", "?")
        usage = getattr(resp, "usage", None)
        print(f"OK in {dt:.1f}s | stop_reason={stop} | content={_summarise(resp)}")
        if usage:
            print(f"  usage: in={usage.input_tokens} out={usage.output_tokens}")


def probe_no_search(client):
    return client.messages.create(
        model=MODEL,
        max_tokens=256,
        messages=[{"role": "user", "content": "Say 'hello papyrus' and nothing else."}],
    )


def probe_search_only(client):
    return client.messages.create(
        model=MODEL,
        max_tokens=1024,
        messages=[
            {
                "role": "user",
                "content": "Use web search to find ONE event happening in San Francisco this week. "
                "Reply in plain text with title and URL.",
            }
        ],
        tools=[
            {"type": "web_search_20260209", "name": "web_search", "max_uses": 2}
        ],
    )


class _One(BaseModel):
    title: str
    url: str


def probe_search_plus_schema(client):
    return client.messages.create(
        model=MODEL,
        max_tokens=1024,
        messages=[
            {
                "role": "user",
                "content": "Use web search to find ONE event in San Francisco this week.",
            }
        ],
        tools=[
            {"type": "web_search_20260209", "name": "web_search", "max_uses": 2}
        ],
        output_config={
            "format": {
                "type": "json_schema",
                "schema": anthropic.transform_schema(_One),
            }
        },
    )


def main() -> int:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY not set", file=sys.stderr)
        return 2
    client = anthropic.Anthropic()
    print(f"model={MODEL} sdk={anthropic.__version__}")
    Probe("1. plain message", probe_no_search).run(client)
    Probe("2. web_search only (no schema)", probe_search_only).run(client)
    Probe("3. web_search + structured output", probe_search_plus_schema).run(client)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
