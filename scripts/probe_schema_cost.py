"""Measure latency for the same event-discovery prompt with and without
structured-output schema enforcement. Logs every content block returned so we
can see how many web_search and code_execution invocations happened.
"""
from __future__ import annotations

import os
import sys
import time

import anthropic
from pydantic import BaseModel, Field


MODEL = os.environ.get("PAPYRUS_LLM_MODEL", "claude-sonnet-4-6")


class _LLMEvent(BaseModel):
    title: str
    description: str | None = None
    category: str
    starts_at: str  # ISO 8601, string for diagnostic simplicity
    ends_at: str | None = None
    venue_name: str | None = None
    address: str | None = None
    url: str


class _LLMResponse(BaseModel):
    events: list[_LLMEvent] = Field(default_factory=list)


SYSTEM = (
    "You discover live, time-bound events in a specific area. "
    "Each event MUST include a real source URL. "
    "Include venue + address but NOT lat/lng (downstream geocodes)."
)

USER = (
    "Find 2 live events happening in San Francisco this week. "
    "Use web search to confirm them."
)


def summarise(resp) -> tuple[int, int, int]:
    n_search = n_code = n_text = 0
    for b in getattr(resp, "content", []):
        t = getattr(b, "type", "?")
        if t == "server_tool_use":
            name = getattr(b, "name", "?")
            if name == "web_search":
                n_search += 1
            elif name == "code_execution":
                n_code += 1
        elif t == "text" and getattr(b, "text", ""):
            n_text += 1
    return n_search, n_code, n_text


def run(client, *, with_schema: bool):
    label = "WITH schema" if with_schema else "WITHOUT schema"
    print(f"\n=== {label} ===", flush=True)
    kwargs = dict(
        model=MODEL,
        max_tokens=2048,
        system=SYSTEM,
        messages=[{"role": "user", "content": USER}],
        tools=[
            {"type": "web_search_20260209", "name": "web_search", "max_uses": 2}
        ],
    )
    if with_schema:
        kwargs["output_config"] = {
            "format": {
                "type": "json_schema",
                "schema": anthropic.transform_schema(_LLMResponse),
            }
        }
    t0 = time.monotonic()
    try:
        resp = client.messages.create(**kwargs)
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED in {time.monotonic()-t0:.1f}s: {type(exc).__name__}: {exc}")
        return
    dt = time.monotonic() - t0
    n_search, n_code, n_text = summarise(resp)
    usage = resp.usage
    print(
        f"OK in {dt:.1f}s | searches={n_search} code_exec={n_code} text={n_text}"
        f" | in={usage.input_tokens} out={usage.output_tokens}"
        f" | stop={resp.stop_reason}"
    )
    # show the text output (truncated)
    for b in resp.content:
        if getattr(b, "type", None) == "text":
            txt = b.text or ""
            print(f"  text[{len(txt)}b]: {txt[:500]!r}")
            break


def main() -> int:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY not set", file=sys.stderr)
        return 2
    client = anthropic.Anthropic(timeout=300.0)
    print(f"model={MODEL} sdk={anthropic.__version__}")
    run(client, with_schema=False)
    run(client, with_schema=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
