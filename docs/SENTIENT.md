# Sentient Labs Integration

How Harborline connects to [Sentient's](https://github.com/sentient-agi) open-source
GRID ecosystem — what each component is, where it plugs into this codebase, and the
boundary it must never cross. Sourced from the upstream repositories and Sentient's
published documentation (retrieved 2026-08-02).

> **The boundary, restated:** Sentient agents reason *over* Harborline's verified
> evidence layer — they never replace it. No Sentient component (or any LLM) decides
> whether a shelter is open or a road is closed. Those facts come from structured
> records with provenance and freshness; agents investigate, synthesize, and explain.

---

## The stack at a glance

| Component | What it is | Status / license | Where it plugs into Harborline |
|---|---|---|---|
| [ROMA](https://github.com/sentient-agi/ROMA) | Recursive Open Meta-Agent — hierarchical multi-agent framework that decomposes complex tasks | v0.1 beta; v0.2.0-beta is a DSPy-based rewrite (`pip install roma-dspy`); Apache-2.0 | The **investigation tier**: multi-source contradiction research, operator briefings |
| [OpenDeepSearch](https://github.com/sentient-agi/OpenDeepSearch) | Search-powered LLM tool for deep web retrieval, built for agent integration (SmolAgents ecosystem) | Apache-2.0; `OpenDeepSearchTool` via pip | Backend for a future `search_verified_news` tool — discovery beyond structured feeds |
| [Sentient Agent Framework](https://github.com/sentient-agi/Sentient-Agent-Framework) | Python package for building agents that serve **Sentient Chat** events over SSE | Beta on PyPI | Serving the Harborline assistant *as a GRID agent* — see below |
| [The GRID](https://blog.sentient.xyz/posts/what-is-grid) | Sentient's coordination network of agents, models, data providers, tools, and compute (110+ partners) | Live network | Distribution: Harborline as a specialized disaster-intelligence agent in the network |

## ROMA — the investigation tier

ROMA runs a recursive plan–execute loop with five modules — **Atomizer** (is the task
atomic?), **Planner** (decompose into a dependency graph), **Executor** (resolve tasks,
optionally with tools via ReAct/CodeAct), **Aggregator** (synthesize results), and
**Verifier** (validate against the goal). It is model-agnostic (any provider through
DSPy/OpenRouter), supports per-module model swapping, and ships an **MCPToolkit** for
connecting to MCP servers.

That shape matches exactly one Harborline job: **non-latency-sensitive
investigations**. Examples:

- "Seattle DOT says closed; a community report says passable — investigate": fan out
  over `compare_source_records`, agency pages, and news, and produce a briefing with
  cited disagreements.
- "Summarize how the flood situation evolved over the last 6 hours for an operator."

Integration contract (`docs/ROADMAP.md`, investigation tier):

1. ROMA runs **out of process** (it is Python; Harborline is TypeScript). It is invoked
   by a queue worker, never in a request path.
2. Its executors get Harborline's read-only tools — `get_active_events`,
   `get_event_details`, `compare_source_records`, `get_official_instructions` — exposed
   over HTTP (or MCP via ROMA's MCPToolkit), so every fact it touches carries
   provenance and freshness.
3. Its output is a **draft investigation report**, stored with
   `composed_by: "investigation"` and run through `validateResponse` like any other
   composition. It is operator-facing first; user-facing only after validation.
4. Never invoked per map pan or per chat question — the deterministic pipeline in
   `packages/agent-tools` answers those.

## OpenDeepSearch — discovery beyond structured feeds

OpenDeepSearch pairs a search provider (**Serper** via `SERPER_API_KEY`, or
**SearXNG**) with a reranker (**Jina** via `JINA_API_KEY`, or self-hosted
**Infinity**) and any LLM through **LiteLLM**. Two modes: *default* (fast SERP
answers) and *pro* (full scrape + semantic rerank for multi-hop questions).

```python
from opendeepsearch import OpenDeepSearchTool

search = OpenDeepSearchTool(model_name="anthropic/claude-sonnet-5", reranker="jina")
search.setup()
result = search.forward("King County flood road closures press briefing")
```

Harborline use — the future `search_verified_news(query, geographic_scope, since)`
tool:

- **Good:** finding municipal incident pages, locating press briefings, researching a
  newly named disaster, collecting context for a ROMA investigation.
- **Never:** determining whether a shelter is open, deciding a road is safe, or
  substituting for an official warning feed. Anything it finds enters the store as a
  **tier C–E source record** and goes through the same normalization, confidence
  scoring, and freshness policy as every other source.

## Sentient Agent Framework — Harborline as a GRID agent

The framework's `AbstractAgent` + `DefaultServer` pattern serves agents that emit
**Sentient Chat events** (JSON, text blocks, streams) over an SSE `/assist` endpoint —
built for showing intermediate work while a response is generated.

Harborline's assistant already produces exactly the intermediate artifacts worth
streaming: *evidence gathered* (events + resources with ages), *candidates rejected*
(stale shelter, closed route — with reasons), then the *validated answer*. A thin
Python adapter can subclass `AbstractAgent`, call Harborline's REST API
(`POST /v1/assistant/ask` plus the tool endpoints), and emit each stage as a chat
event — making Harborline a specialized disaster-intelligence agent inside Sentient
Chat / the GRID without moving any decision logic out of this codebase.

## What Sentient does not provide

The hackathon lesson that shaped this repo: Sentient's strength here is **agent
orchestration and retrieval above the evidence layer**. The safety-critical substrate —
NWS/USGS/FEMA feeds, geospatial storage, freshness enforcement, routing, the safety
validator — is Harborline's own, and every Sentient-powered path terminates in the
same `validateResponse` gate as the deterministic one.

## Sources

- [sentient-agi/ROMA](https://github.com/sentient-agi/ROMA) · [Releases](https://github.com/sentient-agi/ROMA/releases) (v0.2.0-beta)
- [sentient-agi/OpenDeepSearch](https://github.com/sentient-agi/OpenDeepSearch) · [announcement post](https://blog.sentient.xyz/posts/open-deep-search-closing-the-gap-between-proprietary-and-open-source-search-ai)
- [sentient-agi/Sentient-Agent-Framework](https://github.com/sentient-agi/Sentient-Agent-Framework) · [examples](https://github.com/sentient-agi/Sentient-Agent-Framework-Examples)
- [What is GRID? — Sentient blog](https://blog.sentient.xyz/posts/what-is-grid)
