# Harborline — Architecture

How a byte of upstream alert data becomes a sentence a user can act on, and every gate it
passes through on the way.

The load-bearing invariant, restated because everything below is downstream of it:
**structured records determine facts; language only restates them. Every operational claim
carries `source` + `last_verified_at`.**

Related reading: [BUILD_GUIDE.md](./BUILD_GUIDE.md) is the implementation spec;
[PLAN_EVALUATION.md](./PLAN_EVALUATION.md) explains the scoping decisions;
[API.md](./API.md) is the wire contract.

---

## 1. Data flow

```
┌──────────────────┐
│ Upstream sources │
│                  │
│ NWS   api.weather.gov/alerts/active?area=WA        Tier A
│ USGS  earthquake.usgs.gov 2.5_week.geojson         Tier A
│ FEMA  ARC Open Shelters FeatureServer (f=geojson)  Tier B
│ demo  local fixtures                               Tier A–E
└────────┬─────────┘
         │  Connector.fetch(now) → ConnectorResult
         │  never throws; failure is { ok: false, error }
         ▼
┌────────────────────────────────────────────────────────────┐
│ INGESTION — services/api/src/scheduler.ts                  │
│                                                            │
│  setInterval per connector at expected_refresh_seconds     │
│  exponential backoff on failure, capped at 5 min           │
│  circuit breaker opens after 3 consecutive failures        │
│  half-open retry probes the source                         │
│  per-source: last_success_at, last_error, failure count    │
└────────┬───────────────────────────────────────────────────┘
         │  { events[], resources[], source_records[] }
         ▼
┌────────────────────────────────────────────────────────────┐
│ NORMALIZATION — connectors/src/normalize.ts                │
│                                                            │
│  dedup key = event_type + geometry hash + time-window      │
│              overlap                                       │
│  mergeEvents(existing, incoming):                          │
│    • source_count += 1                                     │
│    • ALL source records retained — provenance is never     │
│      merged away                                           │
│    • best_tier = max authority among contributors          │
│    • lower-tier disagreement → contradiction_note,         │
│      never an averaged status                              │
└────────┬───────────────────────────────────────────────────┘
         ▼
┌────────────────────────────────────────────────────────────┐
│ VERIFICATION — packages/event-schema/src/confidence.ts     │
│                             .../freshness.ts               │
│                                                            │
│  confidence_score = authority × freshness × corroboration  │
│                     × precision × consistency              │
│  confidence_label = confidenceLabel(score, best_tier)      │
│  isStale(last_verified_at, maxAge, now) marks records that │
│  are still displayed but barred from recommendations       │
└────────┬───────────────────────────────────────────────────┘
         ▼
┌────────────────────────────────────────────────────────────┐
│ STORE — packages/agent-tools/src/store.ts                  │
│                                                            │
│  interface EventStore  (geometry in, geometry out)         │
│    putEvent / getEvent / queryEvents({lat,lon,radius_m,…}) │
│    putResource / getResource / queryResources(…)           │
│    putSourceRecord / getSourceRecords(entity_id)           │
│    subscribe(listener)  ← drives SSE                       │
│                                                            │
│  MemoryStore  — haversine radius scans, today's default    │
│  PostgisStore — same interface, ST_DWithin/ST_Intersects   │
└────────┬───────────────────────────────────────────────────┘
         │
  ┌──────┴───────────────────────────────────┐
  ▼                                          ▼
┌───────────────────────────┐   ┌─────────────────────────────────────┐
│ DETERMINISTIC SERVICES    │   │ AGENT TOOLS                         │
│ packages/agent-tools      │   │ packages/agent-tools                │
│                           │   │                                     │
│ • nearby resources with   │   │ planQuery(question)                 │
│   distance_m + stale      │   │   → tool set                        │
│   rejection               │   │ tools(ToolContext{store, now})      │
│ • route-risk pipeline     │◀─▶│   → structured evidence JSON        │
│   (k-shortest → hazard    │   │ composeResponse(evidence, question) │
│   intersection →          │   │   → AssistantResponse               │
│   elimination → scoring)  │   │ llmCompose(...)  optional wording   │
│ • freshness gating        │   │ validateResponse(...)  hard gate    │
└───────────┬───────────────┘   └──────────────────┬──────────────────┘
            └───────────────┬────────────────────  ┘
                            ▼
        ┌───────────────────────────────────────────────┐
        │ API — services/api (Hono, :8787)              │
        │ thin handlers; zod-validated JSON, snake_case │
        │ GET /v1/health /v1/events /v1/resources       │
        │     /v1/routes  /v1/stream (SSE)              │
        │ POST /v1/assistant/ask                        │
        └───────────────────────┬───────────────────────┘
                                ▼
        ┌───────────────────────────────────────────────┐
        │ WEB — apps/web (Next.js 16, :3000)            │
        │ MapLibre map │ live feed (SSE) │ assistant    │
        │ types imported from @harborline/event-schema  │
        └───────────────────────────────────────────────┘
```

---

## 2. `@harborline/event-schema` — the contract

The schema package is the only place where domain types are defined. Every other workspace
imports from `@harborline/event-schema` and none of them re-declares a shape.

| Module | Exports |
|---|---|
| `geo.ts` | `Point`, `LineString`, `Polygon`, `MultiPolygon`, `Geometry`; `haversineMeters`, `pointInPolygon`, `pointInGeometry`, `distanceToLineStringMeters`, `geometryCentroid`, `PUGET_SOUND_BBOX`, `SEATTLE_CENTER` |
| `events.ts` | `CanonicalEvent`, `SourceRecord`, `EventType`, `Severity`, `Urgency`, `Certainty`, `EventStatus`, `SourceTier`, `ConfidenceLabel`, `SEVERITY_RANK` |
| `resources.ts` | `Resource`, `NearbyResource`, `ResourceType`, `OperationalStatus` |
| `routing.ts` | `RoadSegment`, `RouteCandidate`, `RouteRecommendation` |
| `confidence.ts` | `TIER_WEIGHT`, `computeConfidence`, `confidenceLabel` |
| `freshness.ts` | `FRESHNESS_POLICY`, `isStale`, `ageSeconds`, `eventMaxAge`, `resourceMaxAge`, `formatAge` |
| `connector.ts` | `Connector`, `ConnectorResult`, `ConnectorItems`, `SourceHealth` |
| `assistant.ts` | `AssistantResponse`, `AssistantSource`, `AssistantAsk` |

Everything is a Zod v4 schema with an inferred type, so the same definition validates the
network boundary and types the code behind it. Three consequences worth naming:

- **Geometry is GeoJSON from end to end.** No bespoke lat/lon tuples in transit, no
  conversion layer between store and map.
- **`source_count` has a minimum of 1.** An event with no source record is unrepresentable.
- **`last_verified_at` is non-nullable on both `CanonicalEvent` and `Resource`.** There is
  no way to construct a displayable record without a verification timestamp.

### Why the contract lives in its own package

The store, the tools, the connectors, the API, the evals, and the web app all need these
types. Putting them in a leaf package with no dependencies other than Zod means the
dependency graph is a tree, `tsc -b` ordering is unambiguous, and a schema change surfaces
as a compile error everywhere it matters in one `npm run check`.

---

## 3. Storage — `MemoryStore` today, `PostgisStore` later

`EventStore` is deliberately shaped like a PostGIS table set rather than like a JavaScript
object graph:

- Queries take a center point plus `radius_m`, not an in-memory predicate function.
- Geometry goes in and comes out as GeoJSON — the exact payload PostGIS accepts via
  `ST_GeomFromGeoJSON` and returns via `ST_AsGeoJSON`.
- Source records are addressed by entity id, mirroring a foreign-key join rather than a
  nested field.
- Writes are single-entity upserts, so each one maps to one `INSERT … ON CONFLICT`.

| Concern | `MemoryStore` | `PostgisStore` (upgrade) |
|---|---|---|
| Radius query | linear scan + `haversineMeters` | `ST_DWithin(geography, …)` with a GiST index |
| Hazard intersection | `pointInGeometry` / segment sampling | `ST_Intersects` / `ST_Buffer` |
| Persistence | none — rebuilt from connectors on boot | durable, survives restart |
| Multi-instance | impossible (per-process state) | shared, the reason to switch |
| Change feed for SSE | in-process `subscribe()` | `LISTEN`/`NOTIFY` or Redis pub/sub |

Because the interface is the same, the upgrade is a constructor swap in
`services/api/src/index.ts` plus a migration file. Nothing in `tools`, `router`, or the
route handlers changes. The re-entry trigger is in [ROADMAP.md](./ROADMAP.md): event volume
outgrowing process memory, or the need for more than one API instance.

---

## 4. Connector contract and the circuit breaker

```ts
interface Connector {
  id: string;
  label: string;
  source_tier: SourceTier;
  expected_refresh_seconds: number;
  fetch(now: Date): Promise<ConnectorResult>;
}
```

`ConnectorResult` is `{ ok: true, retrieved_at, events, resources, source_records }` or
`{ ok: false, retrieved_at, error }`. **A connector never throws to the scheduler.** An
upstream 500, a DNS failure, or a Zod parse error all become `ok: false` with a message, so
every failure is observable at `GET /v1/health` instead of vanishing into an unhandled
rejection.

State machine per source:

```
   CLOSED ──── fetch ok ────▶ CLOSED           consecutive_failures = 0
      │                                        interval = expected_refresh_seconds
      │ fetch fails
      ▼
   CLOSED (backing off)                        interval = min(base × 2^n, 300s)
      │ 3rd consecutive failure
      ▼
   OPEN ──── after backoff window ────▶ HALF-OPEN
                                             │ probe ok    → CLOSED, counters reset
                                             │ probe fails → OPEN, backoff continues
```

While a circuit is open, no requests are sent to that upstream, the source reports
`healthy: false` and `circuit_open: true`, and **records that source already contributed
stay in the store and keep ageing**. They are not deleted — they simply become stale under
the freshness policy and drop out of recommendations on their own. Silence from a source is
never read as "the hazard cleared".

Zod validation sits at the top of every `fetch`. An upstream schema change is a parse
failure, which is a `ok: false` result, which trips the breaker — a loud, visible
degradation rather than a silent stream of malformed events.

---

## 5. Trust tiers

Authority is a property of the *source*, not of the claim. Tier is assigned at connector
level and carried on every `SourceRecord` as `provider_tier`; an event's `best_tier` is the
highest authority among its contributing records.

| Tier | Meaning | Weight | Examples | Ceiling on user-facing label |
|---|---|---|---|---|
| **A** | Issuing authority — the body legally responsible for the declaration | `1.00` | NWS alert, USGS earthquake, city evacuation order | `official` |
| **B** | Operational authority — the body that operates the thing being described | `0.92` | Seattle DOT closure, utility outage feed, FEMA/ARC shelter status | `official` |
| **C** | Verified institution — established newsroom or institutional account | `0.75` | Local newsroom report | `verified` |
| **D** | Corroborated community report — multiple independent reports agreeing | `0.55` | Deferred; see [ROADMAP.md](./ROADMAP.md) | `developing` |
| **E** | Unverified single report | `0.30` | Unverified social post | `unverified` (hard cap) |

Tier D is defined in the schema but has no producing connector in the MVP; community intake
is deferred precisely because unreviewed input is the fastest way to poison a trust layer.

---

## 6. Confidence formula and label gating

```
confidence_score = authority × freshness × corroboration × precision × consistency
```

| Factor | Source | Values |
|---|---|---|
| `authority` | `TIER_WEIGHT[tier]` | A `1.0`, B `0.92`, C `0.75`, D `0.55`, E `0.3` |
| `freshness` | age vs the type's max age | `1 − 0.65 × ageRatio` while `ageRatio ≤ 1`; hard floor `0.2` beyond max age |
| `corroboration` | independent sources | 1 → `0.85`, 2 → `0.95`, 3+ → `1.0` |
| `precision` | geometry specificity | `1.0` precise polygon, down to `0.5` city-wide scope |
| `consistency` | source agreement | `1.0` all agree, down to `0.4` actively disputed |

The result is clamped to `[0, 1]`.

**Label gating** — `confidenceLabel(score, tier)` applies the tier ceiling *before* the
score:

```
tier === "E"                              → "unverified"   (regardless of score)
score >= 0.8 && (tier === "A" || "B")     → "official"
score >= 0.6                              → "verified"
score >= 0.4                              → "developing"
otherwise                                 → "unverified"
```

A tier E report can never be labelled anything but `unverified`, no matter how fresh,
precise, or numerous. A tier C source can reach `verified` but never `official` — the
`official` branch tests tier explicitly.

> [!IMPORTANT]
> **The numeric score is internal.** It exists for ranking and label derivation. Users see
> the four ordinal labels and never a percentage, because the formula is transparent but
> **uncalibrated** — the factor weights are reasoned, not fitted to outcome data. Showing
> "73% confident" would imply a calibration that does not exist.

---

## 7. Freshness policy

`FRESHNESS_POLICY` (`packages/event-schema/src/freshness.ts`) sets the maximum acceptable
age, in seconds, before a record is **stale**. Stale records are still displayed with their
age; they are excluded from recommendations and must never be described as current.

### Events

| Event type | Max age | Seconds | Rationale |
|---|---|---|---|
| `fire` | 1 h | `3600` | Fastest-moving hazard in the set |
| `flood` | 2 h | `7200` | Water levels change within a storm cycle |
| `power_outage` | 2 h | `7200` | Utility crews restore incrementally |
| `shelter_full` | 2 h | `7200` | Capacity flips fast; a full shelter may reopen |
| `transit_disruption` | 2 h | `7200` | Service restores on operational timescales |
| `road_closure` | 4 h | `14400` | DOT closures persist but are re-surveyed |
| `weather_warning` | 6 h | `21600` | Bounded by its own `ends_at` in practice |
| `landslide` | 12 h | `43200` | Slow to change once the slope has moved |
| `evacuation_order` | 12 h | `43200` | Long-lived by design; rescinded explicitly |
| `earthquake` | 24 h | `86400` | The event is instantaneous and historical |
| `shelter_open` | 24 h | `86400` | Matches the FEMA/ARC daily sync cadence |

### Resources

| Resource type | Max age | Seconds | Rationale |
|---|---|---|---|
| `transport_hub` | 6 h | `21600` | Operational status shifts with service |
| `food_water` | 12 h | `43200` | Distribution points run in day-parts |
| `charging` | 12 h | `43200` | Same operational cadence as food/water |
| `shelter` | 24 h | `86400` | FEMA shelter layer syncs daily — honest ceiling |
| `cooling_center` | 24 h | `86400` | Opened by declaration, day-scale |
| `hospital` | 7 d | `604800` | Facilities are near-permanent |

Helpers: `ageSeconds(lastVerifiedAt, now)`, `isStale(lastVerifiedAt, maxAgeSeconds, now)`
(strictly greater than), `eventMaxAge(type)`, `resourceMaxAge(type)`, and
`formatAge(lastVerifiedAt, now)` which yields `"just now"`, `"8 min ago"`, `"2 h ago"`,
`"3 d ago"`.

Freshness enters the system in three places, which is why it cannot be forgotten: it is a
multiplicative factor in `computeConfidence`, a hard filter in the resource and routing
tools, and violation class 2 in `validateResponse`.

---

## 8. Route-risk pipeline

Lives in `packages/agent-tools/src/router.ts`, shared by the API handler, the
`calculate_routes` / `score_route_risk` tools, and the evals. Road graph:
`packages/agent-tools/src/data/seattle-graph.ts` — a hand-authored, bounded lattice of
roughly 30–60 nodes on real streets around Capitol Hill and the Central District.

```
  origin (lat, lon) + destination resource
            │
            ▼
  1. SNAP        nearest graph node to each endpoint
            │
            ▼
  2. ENUMERATE   k-shortest paths, k ≤ 4
                 Dijkstra, then rerun with a penalty applied to
                 edges already used, to force genuine alternatives
            │
            ▼
  3. INTERSECT   for each candidate, test every segment against every
                 active hazard geometry:
                   pointInPolygon for polygon hazards
                   segment-buffer distance for line/point hazards
                 → intersecting_event_ids, hazard_exposure_m
            │
            ▼
  4. ELIMINATE   any candidate crossing a road_closure or an
                 evacuation_order geometry is marked
                   eliminated: true
                   rejected_reason: "closure_intersection" | "evacuation_zone"
                 Eliminated candidates are RETURNED, not hidden —
                 the rejection is part of the evidence.
            │
            ▼
  5. SCORE       survivors:
                   risk_score = travel
                              + hazard_exposure
                              + closure_penalty
                              + stale_data_penalty
                 stale_data_penalty rises when the hazard records the
                 scoring depends on are past their freshness policy.
            │
            ▼
  6. RECOMMEND   lowest risk_score wins → RouteRecommendation
                   summary: "lowest-risk route currently available …"
                   evidence_event_ids: the hazards actually considered
                   routing: "demonstration"   (literal type, always)
                 No survivor → recommendation: null, with the
                 eliminated candidates and their reasons returned.
```

Two properties are enforced by the type system rather than by convention:
`RouteRecommendation.routing` is `z.literal("demonstration")`, so a response that omits the
demonstration label does not type-check; and `rejected_reason` is a closed enum, so a
candidate cannot be dropped for an undocumented reason.

Language rule: the summary says **"lowest-risk route currently available"**. Never "safe",
never "safest" unqualified. The safety validator enforces this independently
(violation class 3), so a hand-written or LLM-written variant cannot slip past.

---

## 9. Assistant pipeline

```
question + lat/lon
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│ planQuery(question)                                          │
│ keyword / intent router — no model call                      │
│   shelter intent   → get_nearby_resources, get_resource_status│
│   road intent      → get_active_events, calculate_routes,     │
│                      score_route_risk                         │
│   what-changed     → get_active_events (time-windowed),       │
│                      compare_source_records                   │
│   general status   → get_active_events,                       │
│                      get_official_instructions                │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ tools(ToolContext { store, now })                            │
│ get_active_events · get_event_details · get_nearby_resources │
│ get_resource_status · calculate_routes · score_route_risk    │
│ get_official_instructions · compare_source_records           │
│                                                              │
│ Pure functions over the store. NO network access.            │
│ Output is structured JSON carrying provenance + freshness.   │
│ This output is the ONLY factual input to everything below.   │
└──────────────────────────┬───────────────────────────────────┘
                           │  evidence
        ┌──────────────────┴───────────────────┐
        ▼                                      ▼
┌────────────────────────┐        ┌─────────────────────────────────┐
│ composeResponse        │        │ llmCompose        OPTIONAL      │
│ deterministic template │        │ Anthropic Messages API          │
│ always available       │        │ default claude-sonnet-5         │
│ constructed to always  │        │ system prompt: "You may only    │
│ pass the validator     │        │ restate the provided evidence"  │
│ composed_by:           │        │ runs only when ANTHROPIC_API_KEY│
│  "deterministic"       │        │ is set. composed_by: "llm"      │
└───────────┬────────────┘        └───────────────┬─────────────────┘
            └───────────────┬────────────────────  ┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ validateResponse(response, evidence, now)   THE HARD GATE    │
│                                                              │
│  1. operational claim (open/closed/blocked/capacity) with    │
│     no matching evidence record                              │
│  2. a record older than its freshness policy described as    │
│     current                                                  │
│  3. guarantee language — /\b(completely |totally |100% )?    │
│     safe\b/i on routes, "guaranteed", "no danger"            │
│  4. contradicts an active evacuation_order in the evidence   │
│  5. sources or timestamps omitted entirely                   │
│  6. LLM-only: phone-number- or street-address-like entities  │
│     in the answer that appear nowhere in the evidence        │
│     bundle ("ungrounded_entity")                             │
│                                                              │
│  → { ok: true } | { ok: false, violations: [...] }           │
└──────────────────────────┬───────────────────────────────────┘
                    ok     │     not ok
              ┌────────────┴────────────┐
              ▼                         ▼
   return AssistantResponse   fall back to composeResponse(evidence)
                              (deterministic, always passes)
                              → returned instead, composed_by:
                                "deterministic"
```

The asymmetry is the point. The deterministic composer is the floor: it is always
available, always passes, and produces a correct if plainer answer. The LLM is a wording
upgrade layered on top, and it is subject to the same gate as any other text. Turning the
API key off degrades prose quality and nothing else — no capability, no coverage, and no
factual content is lost.

`AssistantResponse` is shaped so a sourceless answer is hard to construct: `sources` and
`freshness_note` are required fields, `evidence_event_ids` ties the prose back to specific
records, and `composed_by` tells the UI (and the evals) which path produced the text.

---

## 9a. Hardening pass (2026-08-02)

A security + correctness review (12 + 22 findings) produced these guarantees, in
addition to the validator's rule 6 above:

**Prompt boundary.** The user question is fenced in `<untrusted_user_question>`
delimiters and declared data-not-instructions in the system prompt;
`capEvidenceForPrompt` bounds what reaches the model (25 events by severity, 25
resources, 400-char descriptions). Provenance fields are always recomputed
deterministically from the full bundle.

**Store lifecycle.** `MemoryStore` is no longer add-only: events whose `ends_at` has
passed are stored/served as `expired` (and excluded by `queryEvents` even if upstream
still says active), `sweepExpired(now)` deletes records older than 4× their freshness
policy and enforces `MAX_EVENTS = 10_000` (oldest evicted first) — the API scheduler
runs it every 5 minutes. `onChange` listeners are isolated: one throwing subscriber
cannot stop ingestion or starve other listeners.

**Routing bounds.** `MAX_SNAP_M = 1500`: an origin or destination farther than 1.5 km
from the demo graph returns `no_path` instead of silently snapping Seattle-ward (a New
York origin no longer yields a 4,000 km "route"). Same-node routes hazard-check the
direct segment instead of skipping checks.

**Freshness edge cases.** Timestamps more than 10 minutes in the future are treated as
maximally stale (`MAX_FUTURE_SKEW_SECONDS`) — clock-skewed upstream data cannot become
permanently fresh. Connector-side: NWS features with no parseable `sent`/`effective`
are skipped rather than stamped with fetch time; 10-digit epoch values are read as
seconds, not milliseconds; FEMA coordinates are range-checked before ingest.

**Upstream fetch bounds.** `fetchJson` refuses redirects (`redirect: "error"`) and caps
response bodies at 32 MB via streamed byte counting before `JSON.parse`.

**Known gaps (tracked in ROADMAP.md):** cross-provider dedup (`dedupKey`/`mergeEvents`)
is exported and tested but not yet wired into the ingest path — two providers reporting
the same flood remain two events until then; `capEvidenceForPrompt` does not yet bound
`source_records.raw_payload`.

---

## 10. Sentient adapter boundary

The product concept originated in a Sentient GRID hackathon, where ROMA (recursive
meta-agent framework) and OpenDeepSearch (web retrieval) were the intended agent runtime.
Both are Python, both are latency-heavy, and both are wrong for a map pan or a "which roads
should I avoid?" question that must answer in well under a second. The original plan already
restricted them to "complex, non-latency-sensitive investigations".

Harborline therefore treats them as a **pluggable capability behind an adapter, not a
dependency**:

```
                    packages/agent-tools
   ┌──────────────────────────────────────────────────────────┐
   │                                                          │
   │  planQuery ──▶ tools ──▶ compose ──▶ validate            │  ← MVP path
   │               (local, deterministic, sub-second)         │    always present
   │                                                          │
   │  ─ ─ ─ ─ ─ ─ ─ ─ ─ adapter slot ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
   │                                                          │
   │  InvestigationAdapter (interface, not implemented)       │  ← future tier
   │    investigate(question, evidence): Promise<Evidence>    │    out of process
   │    → ROMA / OpenDeepSearch service over HTTP             │
   │    → returns EVIDENCE, never prose                       │
   │                                                          │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼
                   the SAME validator gate
```

Three rules make the boundary safe:

1. **An adapter returns evidence, not answers.** Anything it produces enters the pipeline at
   the same point tool output does, and passes through `composeResponse`/`llmCompose` and
   `validateResponse` unchanged. A retrieval agent cannot write directly to the user.
2. **Adapter results are source records like any other.** They arrive with a provider, a
   tier (C at best for open-web retrieval; E for anything uncorroborated), a URL, and a
   timestamp. They are ranked, labelled, and aged by the same rules as an NWS alert.
3. **The adapter is never on the interactive path.** Investigation is an explicitly slower
   tier — invoked deliberately, not on every question — so the deterministic path's latency
   budget is unaffected whether the adapter exists or not.

The same slot shape applies to the other deferred external engines: an OSRM/Valhalla
routing adapter behind the route-risk pipeline's step 2, and a `PostgisStore` behind
`EventStore`. In each case the MVP ships the interface and a working local implementation,
and the external system becomes a drop-in when its re-entry trigger fires. Triggers are
documented in [ROADMAP.md](./ROADMAP.md).
