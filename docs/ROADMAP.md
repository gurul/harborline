# Harborline — Roadmap

Everything deliberately left out of the MVP, with **the condition that brings it back in**.

The scoping rationale is in [PLAN_EVALUATION.md](./PLAN_EVALUATION.md): the original plan
was a 12-week, five-person funded-pilot plan, and this repo is a verifiable vertical slice
of it that keeps every architectural principle while cutting infrastructure and liability
surface the MVP does not need.

Two rules govern this list:

1. **Nothing here is blocked on a rewrite.** Each deferred capability has a seam in the code
   today — an interface, an adapter slot, or a schema field — so re-entry is an
   implementation, not a redesign.
2. **A trigger is a condition, not a date.** "When we have time" is not a trigger. Each
   entry below names something observable that must be true first.

Legend: **Seam** is what already exists to plug into. **Trigger** is the condition that
starts the work.

---

## 1. PostGIS storage adapter

Replace `MemoryStore` with a `PostgisStore` behind the same `EventStore` interface: durable
storage, `ST_DWithin` radius queries with GiST indexes, `ST_Intersects` for hazard
geometry, and `LISTEN`/`NOTIFY` (or Redis pub/sub) driving the SSE change feed instead of an
in-process subscription.

- **Seam:** `EventStore` in `packages/agent-tools/src/store.ts` is already PostGIS-shaped —
  geometry in and out as GeoJSON, centre-plus-radius queries, source records addressed by
  entity id, single-entity upserts. `infrastructure/docker-compose.yml` already ships the
  PostGIS 16 / PostGIS 3.4 container. The swap is a constructor change in
  `services/api/src/index.ts` plus migrations.
- **Trigger:** **event volume outgrows process memory, or a second API instance is
  required.** Concretely — sustained active-event counts where linear haversine scans show
  up in request latency, a need for state to survive restarts, or any horizontal scaling
  (two instances against `MemoryStore` give two divergent views of the world).
- **Not a trigger:** wanting a "real database". Single-instance in-memory is the correct
  choice while it holds.

## 2. Real routing engine (OSRM / Valhalla)

Replace the bounded hand-authored Seattle graph with a full street network behind a routing
adapter, keeping the existing hazard-intersection, closure-elimination, and risk-scoring
stages on top.

- **Seam:** the route-risk pipeline in `packages/agent-tools/src/router.ts` separates
  *candidate enumeration* (step 2) from *hazard scoring* (steps 3–6). Only step 2 is
  replaced. `RouteCandidate` and `RouteRecommendation` already carry `risk_score`,
  `intersecting_event_ids`, `rejected_reason`, and the `routing` literal.
- **Trigger:** **a data-quality SLA exists for road-closure feeds.** Real evacuation
  routing over live road networks is the highest-liability feature in the plan. What must
  be true first: a committed refresh cadence and completeness guarantee from SDOT/WSDOT for
  closures, a measured false-negative rate on that feed, and a legal review of the guidance
  being given. Until then the `routing: "demonstration"` label stays and the language stays
  "lowest-risk route currently available".
- **Ordering note:** the routing engine swap is worthless without the closure SLA. Better
  street geometry with unreliable closure data produces a *more* confident wrong answer.

## 3. Notifications and watched areas

Let a user save a location and receive a push when a qualifying event appears, escalates, or
is rescinded within it.

- **Seam:** the store's `subscribe()` change feed already fires on every upsert — the same
  signal that drives SSE. A notification service is a second consumer of it, with a
  geometry-match predicate per subscription.
- **Trigger:** **sustained returning users.** A notification you cannot unsubscribe from,
  or that fires on a stale record, is worse than no notification. Requires: user identity
  and preference storage (currently none), a delivery channel with retry, a rate/dedup
  policy so one flood does not send eleven pushes, and a rescind path so a cancelled alert
  actually cancels. Do not build until there is an audience to notify.

## 4. Offline and low-bandwidth mode

A cached last-known-good view that renders with degraded or absent connectivity: cached
tiles, cached events with prominent age indicators, and a text-first low-bandwidth layout.

- **Seam:** every record already carries `last_verified_at`, and `formatAge` already renders
  it, so "this is what we knew 40 minutes ago" is displayable without any schema change.
  The freshness policy defines exactly when a cached record must stop being described as
  current.
- **Trigger:** **field or drill usage where connectivity is unreliable** — the first real
  deployment with users on congested or degraded networks during an incident. Hard
  requirement: an offline view must be visibly, unmistakably distinct from a live one.
  A cached shelter status presented as current is the worst failure this product can have.

## 5. Community reports

Public intake of observations, with a state machine that never lets an unverified report
masquerade as an official one:

```
   submitted
       │
       ▼
  unverified  ── 2+ independent reports agreeing ──▶  corroborated
   (Tier E)         within a time + distance window        (Tier D)
       │                                                      │
       │                       an authority (Tier A/B) confirms│
       ▼                                                      ▼
   expires quietly                                        verified
   (no promotion)                                     (Tier A/B record;
                                                   the community report is
                                                   retained as corroboration,
                                                   never as the source)
```

- **Seam:** tiers **D** (corroborated community report) and **E** (unverified report) are
  already defined in `SourceTierSchema` with weights `0.55` and `0.30`. `confidenceLabel`
  already hard-caps tier E at `unverified` regardless of score. `contradiction_note` already
  exists for the case where a community report disputes an official record — the demo
  scenario exercises exactly this. What is missing is a producing connector, an intake
  endpoint, and the promotion logic above.
- **Trigger:** **a moderation capability exists** — human review capacity, or a defensible
  automated corroboration rule with a measured false-promotion rate, plus abuse controls.
  Unreviewed community input is the single fastest way to poison the trust layer, which is
  why this is deferred rather than merely unbuilt.
- **Invariant:** promotion **never** rewrites the original record's tier. A corroborated
  report becomes a tier D record alongside the tier E one; both are retained. Provenance is
  never merged away.

## 6. Operator console

An internal view for emergency-management staff: source health over time, ingestion error
detail with raw payloads, manual event suppression and correction, an audit log of every
override, and validator-rejection review.

- **Seam:** `SourceHealth` and `/v1/health` already expose per-source state, and
  `SourceRecord.raw_payload` already retains upstream payloads for diagnosis. Validator
  rejections already carry structured `violations`.
- **Trigger:** **an operating organization exists** — a named team accountable for the data
  quality. A manual-override console without an accountable operator is an unaudited
  fabrication path straight through the trust layer, which is the one thing the architecture
  is built to prevent. Every override must be an attributed, timestamped record.

## 7. ROMA / OpenDeepSearch investigation tier

An explicitly slower, deliberately invoked research tier for complex questions the
deterministic tools cannot answer from the store — multi-hop questions, questions needing
open-web retrieval, questions requiring synthesis across sources.

- **Seam:** the `InvestigationAdapter` slot described in
  [ARCHITECTURE.md](./ARCHITECTURE.md#10-sentient-adapter-boundary). An adapter returns
  **evidence, never prose**, entering the pipeline where tool output does and passing
  through the same `validateResponse` gate. Results become source records with a provider,
  a tier (C at best for open-web retrieval, E for anything uncorroborated), a URL, and a
  timestamp.
- **Trigger:** **a class of real user questions the deterministic tools demonstrably cannot
  answer, plus ROMA reaching non-beta stability.** Both conditions, not either. Today ROMA
  is a beta recursive meta-agent framework and OpenDeepSearch is a Python web-retrieval
  tool; both are latency-heavy and wrong for a map pan or a shelter lookup — the original
  plan says as much. Adopting them before there is a question they answer better would add
  a Python runtime, a second deployment surface, and framework-churn risk for no user gain.
- **Constraint on entry:** the adapter never goes on the interactive path. The
  sub-second deterministic route must stay sub-second whether the adapter exists or not.

## 8. SMS fallback

Query Harborline by text message for users with no data connection or no smartphone: a
short-code or number that accepts "shelter" plus a location and returns a plain-text answer
with source and timestamp.

- **Seam:** `AssistantResponse` is already structured rather than free-form — `answer_markdown`,
  `recommended_action`, `sources`, `freshness_note` — so an SMS renderer is a formatter over
  the existing pipeline, not a second answer path. Same tools, same validator.
- **Trigger:** **a deployment partner with an emergency-communications mandate**, i.e. a
  county or city agency. Requires a carrier relationship, a registered short code,
  per-message cost budgeting, and — critically — an agreed message-length policy, because
  the sources and timestamps are **not** the part you truncate. If a source citation will
  not fit, the answer does not fit.

## 9. Mobile applications

Native iOS and Android clients: background location, push delivery, offline map packs,
and lock-screen alert surfaces.

- **Seam:** the API is a plain REST + SSE surface with `snake_case` JSON and GeoJSON
  geometry — nothing about it is web-specific. A native client is a new consumer, not a new
  backend.
- **Trigger:** **notifications (#3) and offline mode (#4) are both shipped and proven on
  web.** Those two are the only reasons to be native; building the app first means
  maintaining three clients while still figuring out the capabilities that justify them.

## 10. Multi-region coverage

Extend beyond Seattle / King County to additional metros, each with its own authority
connectors, tier assignments, and geography.

- **Seam:** connectors are already scoped by bounding box (`PUGET_SOUND_BBOX`), and nothing
  in the canonical schema is Seattle-specific. Region becomes a query dimension and a
  connector-registry key.
- **Trigger:** **the Seattle deployment is operationally boring** — sources stable, breaker
  trips rare and explained, no open data-quality issues. Every new region multiplies the
  connector surface and the tier-assignment judgement calls. Going wide before the first
  region is dull turns one maintenance problem into *n*.

---

## Also deferred, smaller

| Item | Seam | Trigger |
|---|---|---|
| **Linter (Biome)** | none needed; `npm run check` runs `tsc --noEmit` today | More than one regular contributor — style drift only costs something when it is other people's style |
| **Observability (OpenTelemetry, Grafana, Sentry)** | `/v1/health` and structured logs today | Deployment beyond localhost; a pilot serving ~100 users does not need a metrics pipeline |
| **Confidence calibration** | `computeConfidence` factor weights are isolated and pure | Enough outcome-labelled historical events to fit against. Until then the score stays internal and users see only ordinal labels |
| **Auth on the API** | Hono middleware slot (per-IP rate limiting shipped in the 2026-08-02 hardening pass) | Any deployment with per-user state |
| **Cross-provider event dedup in the ingest path** | `dedupKey`/`mergeEvents` are exported from `@harborline/connectors` and covered by evals; ingest currently keys on `event_id` only | A second live source reporting the same hazard class as an existing one (e.g. adding a WSDOT closures connector alongside NWS) |
| **Prompt-size bound on `raw_payload`** | `capEvidenceForPrompt` caps events/resources/descriptions; `source_records.raw_payload` is still unbounded | Before any tier C–E source whose payloads are not government-schema JSON is added |
| **Container images and deployment manifests** | `infrastructure/` | A hosting target. `docker-compose.yml` covers local dependencies only — see [infrastructure/README.md](../infrastructure/README.md) |
| **Additional connectors** (Seattle City Light outages, King County Metro, WSDOT) | the `Connector` interface; see [RUNBOOK.md](./RUNBOOK.md#adding-a-connector) | Each is small and independent — add when a demo or user need calls for that hazard class |
