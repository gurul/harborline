# Harborline — Comprehensive Build Guide

The implementation spec for the Harborline MVP: a real-time disaster intelligence and
navigation system for Seattle / King County. **The core product is a verified
geospatial event layer; language models sit above it to explain, never to originate
facts.**

Read `docs/PLAN_EVALUATION.md` for why the MVP is scoped this way.

---

## 0. Ground rules (apply to every package)

- **All TypeScript.** ESM (`"type": "module"`), strict mode, TypeScript ^7.0.2.
- **Zod v4** for every external boundary: upstream API payloads, REST request/response,
  tool inputs/outputs.
- **Provenance and freshness are mandatory.** Any value shown to a user that describes
  the physical world carries `source` + `last_verified_at` (or derives from a record
  that does).
- **No fabrication paths.** If data is missing, the answer is "unknown / not verified",
  never an inference.
- The shared contract is `@harborline/event-schema`. Nobody redefines those types.

## 1. Monorepo layout (npm workspaces)

```
harborline/
├── package.json                 # workspaces: apps/*, services/*, packages/*, connectors, evals
├── tsconfig.base.json
├── apps/
│   └── web/                     # Next.js 16 — map, live feed, assistant
├── services/
│   └── api/                     # Hono — REST + SSE + ingestion scheduler
├── connectors/                  # @harborline/connectors — NWS, USGS, FEMA, demo
├── packages/
│   ├── event-schema/            # @harborline/event-schema — canonical types (AUTHORED, do not restructure)
│   └── agent-tools/             # @harborline/agent-tools — tool layer, safety validator, composer
├── evals/                       # @harborline/evals — safety + dedup + scenario tests (Vitest)
├── infrastructure/              # docker-compose (PostGIS, Redis), Dockerfiles — optional
└── docs/
```

Grounded dependency versions (npm registry, 2026-08-02): `next@16.2.12`,
`hono@4.12.33`, `zod@4.4.3`, `maplibre-gl@6.1.0`, `tailwindcss@4.3.3`,
`@tanstack/react-query@5.101.4`, `typescript@7.0.2`, `vitest@4.1.10`, `tsx@4.23.1`.

## 2. Canonical schema — `@harborline/event-schema`

Already authored at `packages/event-schema/src/`. Key exports (import from
`@harborline/event-schema`):

- `CanonicalEvent` — id, `event_type` (enum: flood, road_closure, power_outage,
  earthquake, fire, landslide, shelter_open, shelter_full, transit_disruption,
  evacuation_order, weather_warning), headline, description, `severity`
  (minor|moderate|severe|extreme), `urgency`, `certainty`, `status`
  (active|expired|cancelled), GeoJSON `geometry`, `starts_at/ends_at`,
  `last_verified_at`, `source_count`, `confidence_score`, `confidence_label`.
- `SourceRecord` — provider, `provider_tier` (A|B|C|D|E), source_url, published_at,
  retrieved_at, raw payload hash.
- `Resource` — shelters/hospitals/etc. with `operational_status`
  (open|closed|full|unknown), capacity, accessibility, `last_verified_at`.
- `RoadSegment`, `RouteCandidate`, `RouteRecommendation` (with `risk_score`,
  `evidence_event_ids`, `rejected_reason` on discarded candidates).
- `Connector` interface — `{ id, source_tier, expected_refresh_seconds,
  fetch(): Promise<ConnectorResult> }` returning canonical events/resources +
  source records.
- `computeConfidence(inputs)` + `confidenceLabel(score)` — transparent multiplicative
  scoring → `official | verified | developing | unverified` labels.
- `FRESHNESS_POLICY` — max acceptable age per event/resource type;
  `isStale(record, policy, now)`.

## 3. Connectors — `connectors/` (`@harborline/connectors`)

Each connector implements `Connector` from the schema package, validates upstream
payloads with Zod, and **never throws to the scheduler** — it returns
`{ ok: false, error }` results so source health is observable.

| Connector | Upstream | Tier | Notes |
|---|---|---|---|
| `nws` | `https://api.weather.gov/alerts/active?area=WA` (GeoJSON; `User-Agent` header required) | A | Map CAP severity/urgency/certainty straight through; keep alert geometry; filter to King County zones when `same`/geocode present |
| `usgs` | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson` | A | Filter to Puget Sound bbox `[-123.3, 46.9, -121.0, 48.3]`; magnitude → severity mapping |
| `fema-shelters` | FEMA/ARC Open Shelters ArcGIS FeatureServer query (f=geojson) | B | Data syncs daily — set honest `last_verified_at` from attributes, not fetch time; endpoint may be empty/unreachable: return `ok:true, items:[]` on empty, `ok:false` on error |
| `demo` | Local fixtures | A–E mixed | The deterministic Seattle flood scenario (§8). Enabled by `DEMO_MODE=1` (default in dev) |

Also export `normalize` helpers: dedup key (`event_type` + geometry hash + time-window
overlap), and `mergeEvents` that increments `source_count` and retains **all** source
records (never merge away provenance).

## 4. API service — `services/api` (Hono, port 8787)

Structure: `src/index.ts` (Hono app), `src/scheduler.ts` (ingestion),
`src/routes/*.ts` (route handlers), `src/router/` (route-risk engine).

**Storage:** the `EventStore` interface and its `MemoryStore` implementation live in
`@harborline/agent-tools` (`src/store.ts`) so tools, the API service, and evals share
one storage contract (put/query events, resources, source records; radius queries via
haversine). Keep the interface PostGIS-shaped (geometry in, geometry out) so a
`PostgisStore` can drop in later.

**Scheduler:** per-connector `setInterval` at `expected_refresh_seconds`, exponential
backoff on failure (cap 5 min), circuit breaker after 3 consecutive failures
(half-open retry), `last_success_at` tracked per source. `DEMO_MODE=1` loads the demo
connector once at boot and keeps live connectors on.

**REST contract (all responses JSON, snake_case, zod-validated):**

```
GET /v1/health                         → { status, uptime_s, sources: [{id, healthy, last_success_at, consecutive_failures}] }
GET /v1/events?lat&lon&radius_m&types  → { events: CanonicalEvent[] }   (sorted severity desc, then freshness)
GET /v1/events/:id                     → { event, source_records }
GET /v1/resources?lat&lon&type&status  → { resources: Resource[] }      (each with distance_m)
GET /v1/resources/:id                  → { resource, source_records }
GET /v1/routes?from_lat&from_lon&to_resource_id
                                       → { candidates: RouteCandidate[], recommendation: RouteRecommendation | null }
POST /v1/assistant/ask  {question, lat, lon}
                                       → AssistantResponse (from @harborline/agent-tools)
GET /v1/stream                         → SSE: `event: feed_update`, data: CanonicalEvent (on every store upsert)
```

CORS open for localhost. Port/env via `PORT`, `DEMO_MODE`, `ANTHROPIC_API_KEY`
(optional).

**Route-risk engine (`src/router/`):** bounded Seattle road graph (~30–60 nodes on a
real street lattice around Capitol Hill/Central District, hand-authored GeoJSON in
`data/seattle-graph.json`), k-shortest-paths (k≤4) via Dijkstra + penalty rerun;
segment vs hazard-geometry intersection (point-in-polygon + segment-buffer distance);
**eliminate** candidates crossing `road_closure`/`evacuation_order` geometries; score
survivors `travel + hazard_exposure + closure_penalty + stale_data_penalty`; recommend
lowest. Response language must be "lowest-risk route currently available", never
"safe". Label: `"routing": "demonstration"` field in every route response.

## 5. Agent runtime — `packages/agent-tools`

Deterministic first, LLM optional. Exports:

- `tools` — typed tool registry: `get_active_events`, `get_event_details`,
  `get_nearby_resources`, `get_resource_status`, `calculate_routes`,
  `score_route_risk`, `get_official_instructions`, `compare_source_records`.
  Each takes a `ToolContext { store, now }` — pure functions over the store, returning
  structured JSON with provenance + freshness. No network access.
- `planQuery(question)` — keyword/intent router → which tools to run (shelter intent,
  road intent, what-changed intent, general-status intent).
- `composeResponse(evidence, question)` — deterministic template composer producing
  `AssistantResponse { answer_markdown, recommended_action, sources: [{provider, tier,
  url, last_verified_at}], freshness_note, uncertainty_note, evidence_event_ids }`.
- `llmCompose(evidence, question, {apiKey, model})` — OPTIONAL: calls Anthropic
  Messages API (`claude-sonnet-5` default, model env-overridable) with the evidence
  JSON and a hard system prompt ("You may only restate the provided evidence…").
  Used only when `ANTHROPIC_API_KEY` is set; **its output still passes the validator**.
- `validateResponse(response, evidence, now)` — the safety-policy validator. Rejects
  (returns `{ok:false, violations:[…]}`) when a response:
  1. makes an operational claim (open/closed/blocked/capacity) with no matching
     evidence record;
  2. describes a record older than its freshness policy as current;
  3. contains guarantee language (`/\b(completely |totally |100% )?safe\b/i` on routes,
     "guaranteed", "no danger");
  4. contradicts an active `evacuation_order` in evidence;
  5. omits sources or timestamps entirely.
  On failure the API falls back to `composeResponse` (deterministic), which is
  constructed to always pass.

## 6. Web app — `apps/web` (Next.js 16, App Router)

**Aesthetic (from the design reference):** near-black background `#0a0a0c`, white
text, generous rounded corners (`rounded-2xl+`), pill buttons, high-signal color
coding: amber status pill (`Status: Elevated risk`), red hazard markers, green "Open"
shelter markers, teal route line, muted grays elsewhere. Tagline in footer:
*"Designed for calm in moments of chaos."* Large touch targets, chunked information,
low noise. Tabular data never over-dense.

**Layout:** header (HARBORLINE wordmark + status pill) above a responsive 3-panel
grid (stacks on mobile):

1. **Map panel** — MapLibre GL, CARTO dark-matter raster tiles
   (`https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`, attribution required).
   Hazard markers/polygons colored by severity, shelter markers with open/closed
   state, user location dot (geolocation with Seattle-center fallback
   `47.6062, -122.3321`), recommended route as teal line. Filter chips: All /
   Hazards / Shelters / Medical / Food & Water. Clicking a marker opens a detail
   card: status, verification label, "Updated N min ago", source, description.
   Bottom bar: "Safest route to nearest open shelter — N min · avoids M hazards"
   (wording: "lowest-risk", see §5 rules — never "safe route" without qualifier).
2. **Live feed panel** — tabs All / Official / Nearby / Weather. Cards show publisher
   + tier badge (Official / Verified / Developing / Unverified), age ("2 min ago"),
   distance, event category chip, headline/body, evidence count. Top slot pins the
   highest-severity active alert with amber accent. Live via SSE (`/v1/stream`)
   merged into TanStack Query cache.
3. **Assistant panel** — chat UI. Suggested prompts: "Where is the nearest open
   shelter?", "Which roads should I avoid?", "What changed in the last hour?".
   Renders `AssistantResponse`: answer, recommended action, source chips with
   timestamps, uncertainty note in muted italic. Answers include "Updated X ago"
   badges. No free-form LLM text without the sources block.

Data layer: TanStack Query + `NEXT_PUBLIC_API_URL` (default `http://localhost:8787`).
SSE with reconnect. All API types imported from `@harborline/event-schema`.
`app/api/` is not used — the Hono service is the only backend.

## 7. Evals — `evals/` (Vitest)

- **Safety:** validator rejects each of the five violation classes (fixture
  responses); deterministic composer output always passes; guarantee-language
  regression corpus.
- **Dedup/normalization:** same NWS alert fetched twice → one event, 1 source record
  set, no duplicate; two providers describing one flood → merged event with
  `source_count: 2` and both source records retained.
- **Freshness:** stale shelter excluded from `get_nearby_resources` recommendations
  path; `isStale` boundary tests.
- **Scenario (§8 acceptance):** run the full demo flow against a `MemoryStore` seeded
  with the demo fixtures and assert every step.

## 8. Acceptance scenario (the §20 demo — must pass end-to-end)

Seeded demo state (in `connectors/src/demo/fixtures.ts`):
active flood warning polygon (NWS-style, Tier A) over Capitol Hill; two road closures
(SDOT, Tier B) — one intersecting the naive best route; three shelters — Calvary
Church (open, verified 8 min ago, Tier B), one **stale** (status 26h old → excluded),
one full; one Tier C news item; one Tier E unverified social report that contradicts
one closure (displayed as contradiction, never merged).

Flow asserted in evals and demo-able in the UI:
1. Map shows flood polygon + 2 closures + shelters; feed ranks official warning first.
2. Ask "Where is the nearest open shelter?" → resource tool returns 3, rejects stale
   one (with `rejected_reason: stale_status`), rejects full one.
3. Routing returns candidates; one eliminated for closure intersection.
4. Recommendation: Calvary Church via lowest-risk route, with duration, sources,
   `last_verified_at`, uncertainty notice.
5. Validator passes the composed answer; a doctored "this route is safe" variant fails.

## 9. Verification (Forced Verification directive)

From repo root: `npm install`, then `npm run check` (workspace-recursive
`tsc --noEmit`), `npm run build` (schema/tools/connectors `tsc -b`, api build, web
`next build`), `npm test` (Vitest evals). All three must pass before the repo is
pushed. No linter is configured in the MVP (stated explicitly; Biome is a roadmap
item).

## 10. Out of scope (documented in ROADMAP.md)

PostGIS adapter, real routing engines (OSRM/Valhalla), notifications/watched areas,
offline cache/low-bandwidth mode, community report intake, operator console,
ROMA/OpenDeepSearch investigation tier, SMS fallback, mobile apps, multi-region.
Each entry carries its re-entry trigger.
