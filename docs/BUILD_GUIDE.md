# Harborline — Comprehensive Build Guide

The implementation spec for the Harborline MVP: a real-time disaster intelligence and
navigation system, location-agnostic behind a single region config (currently California, centred on Chico / Butte County). **The core product is a verified
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
| `nws` | `https://api.weather.gov/alerts/active?area=<REGION.nwsArea>` (GeoJSON; `User-Agent` header required) | A | Map CAP severity/urgency/certainty straight through; keep alert geometry |
| `usgs` | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson` | A | Filter to the region bbox (`REGION.bbox` — California statewide by default); magnitude → severity mapping |
| `fema-shelters` | FEMA/ARC Open Shelters ArcGIS FeatureServer query (f=geojson) | B | Data syncs daily — set honest `last_verified_at` from attributes, not fetch time; endpoint may be empty/unreachable: return `ok:true, items:[]` on empty, `ok:false` on error |
| `demo` | Local fixtures | A–E mixed | The deterministic California wildfire scenario (§8). Enabled by `DEMO_MODE=1`, which `npm run dev:api` sets; off otherwise |

Also export `normalize` helpers: dedup key (`event_type` + geometry hash + time-window
overlap), and `mergeEvents` that increments `source_count` and retains **all** source
records (never merge away provenance).

## 4. API service — `services/api` (Hono, port 8787)

Structure: `src/index.ts` (Hono app), `src/scheduler.ts` (ingestion),
`src/routes/*.ts` (route handlers). The route-risk engine lives in
`@harborline/agent-tools` (shared with tools and evals) — API handlers stay thin.

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

**Route-risk engine (`packages/agent-tools/src/router.ts`):** bounded demo road graph (20 nodes on a
real street lattice around the Avenues in Chico, CA, hand-authored in
`data/demo-graph.ts`), k-shortest-paths (k≤4) via Dijkstra + penalty rerun;
segment vs hazard-geometry intersection (point-in-polygon + segment-buffer distance);
**eliminate** candidates crossing `road_closure`/`evacuation_order` geometries or a
severe fire/flood/landslide area; score `travel_min + hazard_exposure_m/100 + 5 if stale`; recommend
lowest. Response language must be "lowest-risk route currently available", never
"safe". Label: `"routing": "demonstration"` field in every route response. The graph
data lives in `packages/agent-tools/src/data/demo-graph.ts`.

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

**Look:** near-black background `#0a0a0c`, white text, rounded cards, and colour
used only for meaning: red and amber for severity, green for an open shelter, teal
for the route and the main action, grey for everything else. Text is never smaller
than 12 px, body text is 16 px, targets are at least 44 px, contrast is at least
4.5:1, focus is always visible, and motion stops when the system asks for reduced
motion.

**Layout:** a header (wordmark, connection status, location, Settings) above a
situation banner that shows the most urgent alert. The header never says "Live"
when the API cannot be reached; it says "Cannot reach Harborline" with the time of
the last data. Below the banner:

- **Desktop (1024 px and up):** a 400 px rail on the left with tabs Now / Alerts /
  Ask, and the map on the right.
- **Phone:** one view at a time, switched by a bottom bar Now / Map / Alerts / Ask.
  The view is kept in the URL (`?view=`), so Back works.

Views:

1. **Now** — the nearest open shelter (distance, direction, capacity, access
   features, source and age) with **Route here**; shelters left out and why;
   tiles for alerts, fire, air quality, river gauge and power. Every tile has
   loading, error, stale and not-connected states and shows its source and age.
   Power reads "Not monitored" because no source is configured.
2. **Map** — MapLibre GL over the keyless OpenFreeMap dark vector style
   (contrast raised in `lib/mapLayers.ts`; attribution from the style). A
   **Layers** menu switches to imagery (USGS aerial photos from zoom 9, the NASA GIBS
   MODIS daily image for a chosen day below zoom 9) and toggles hazards, fire detections, closures, shelters, medical and
   food & water. Satellite heat detections draw as unconfirmed footprints shaded
   by age. Clicking a marker opens a place card. A route goes only to the shelter
   the user chose or the answer named; the route bar uses "lowest-risk" wording,
   never "safe".
3. **Alerts** — filters All / Official / Within 3 km / Weather. Each row shows
   severity, confidence label, type, distance and age; a detail page shows the
   instructions, description, contradiction note and sources.
4. **Ask** — chat with prompt cards ("Where is the nearest open shelter?",
   "Which roads should I avoid?", "What changed in the last hour?", "What should
   I do right now?"). Renders `AssistantResponse`: recommended action first, then
   the answer, sources with ages, freshness and uncertainty notes. **Route to**
   draws the answer's own `route` when it has one.

**Settings sheet:** location (device, a point picked on the map, or the region
default), access needs and larger text, saved in `localStorage` under
`hl.prefs.v1`. Access needs the API accepts (`wheelchair`, `accessible_restroom`,
`pets`) are sent with assistant requests.

Data layer: TanStack Query + `NEXT_PUBLIC_API_URL` (default `http://localhost:8787`).
SSE with reconnect. All API types imported from `@harborline/event-schema`.
`app/api/` is not used — the Hono service is the only backend.

## 7. Evals — `evals/` (Vitest)

- **Safety:** validator rejects each of the five violation classes (fixture
  responses); deterministic composer output always passes; guarantee-language
  regression corpus.
- **Dedup/normalization:** same NWS alert fetched twice → one event, 1 source record
  set, no duplicate; two providers describing one fire → merged event with
  `source_count: 2` and both source records retained.
- **Freshness:** stale shelter excluded from `get_nearby_resources` recommendations
  path; `isStale` boundary tests.
- **Scenario (§8 acceptance):** run the full demo flow against a `MemoryStore` seeded
  with the demo fixtures and assert every step.

## 8. Acceptance scenario (the §20 demo — must pass end-to-end)

Seeded demo state (in `connectors/src/demo/fixtures.ts`):
active wildfire evacuation-warning polygon (CAL FIRE-style, Tier A) over east Chico; two road closures
(public works, Tier B) — one intersecting the naive best route; three shelters — Neighborhood
Church (open, verified 8 min ago, Tier B), one **stale** (status 26h old → excluded),
one full; one Tier C news item; one Tier E unverified social report that contradicts
one closure (displayed as contradiction, never merged).

Flow asserted in evals and demo-able in the UI:
1. Map shows fire polygon + 2 closures + shelters; feed ranks official warning first.
2. Ask "Where is the nearest open shelter?" → resource tool returns 3, rejects stale
   one (with `rejected_reason: stale_status`), rejects full one.
3. Routing returns candidates; one eliminated for closure intersection.
4. Recommendation: Neighborhood Church via lowest-risk route, with duration, sources,
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
