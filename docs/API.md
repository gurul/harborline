# Harborline — API Reference

The Hono service in `services/api` is the only backend. It listens on **`http://localhost:8787`**
by default (`PORT` overrides). The Next.js app at `:3000` talks to it through
`NEXT_PUBLIC_API_URL` and uses `app/api/` for nothing.

Conventions that hold for every endpoint:

- **JSON in, JSON out.** `Content-Type: application/json`.
- **`snake_case` field names**, matching the Zod schemas in `@harborline/event-schema`.
- **Every response is validated** against its schema before it is sent. A response that
  would fail validation is a `500`, not a malformed body.
- **Timestamps are ISO 8601 with a `Z` offset.**
- **Geometry is GeoJSON**, coordinates as `[lon, lat]`.
- **CORS is open for localhost** origins in development.
- Every record that describes the physical world carries `last_verified_at` and a provider
  with a tier. There is no endpoint that returns an unattributed fact.

> [!NOTE]
> All examples below use the **demo scenario** seeded by `DEMO_MODE=1` — a wildfire
> evacuation warning over east Chico, CA, two Chico Public Works closures (one on
> Oleander Ave), and three shelters including Neighborhood Church. Demo fixtures are
> synthetic: the coordinates are real Chico geography, the facilities and incidents are
> not. Example responses are rendered as of a fixed `now = 2026-08-02T18:40:00Z`, so ages
> and confidence scores are reproducible.

---

## Endpoint index

| Method | Path | Returns |
|---|---|---|
| `GET` | `/v1/health` | Service status and per-source ingestion health |
| `GET` | `/v1/events` | Active canonical events near a point |
| `GET` | `/v1/events/:id` | One event plus all its source records |
| `GET` | `/v1/resources` | Nearby resources with `distance_m` |
| `GET` | `/v1/resources/:id` | One resource plus provenance and its freshness verdict |
| `GET` | `/v1/routes` | Route candidates and a recommendation |
| `POST` | `/v1/assistant/ask` | An `AssistantResponse` |
| `GET` | `/v1/stream` | Server-Sent Events on every store upsert |

---

## Limits and safeguards (2026-08-02 hardening pass)

These bounds apply on top of the per-endpoint documentation below. Where an example
below disagrees with this table, this table wins.

| Boundary | Limit | Behavior when exceeded |
|---|---|---|
| Rate limit, all `/v1/*` | 120 req/min per IP (token bucket, socket address; first `x-forwarded-for` entry only when `TRUST_PROXY=1`) | `429 {"error":"rate_limited"}` with `Retry-After` |
| Rate limit, `POST /v1/assistant/ask` | 6 req/min per IP | `429`, same shape |
| Request body, `/v1/assistant/*` | 8 KiB | `413 {"error":"payload_too_large"}` |
| List size, `/v1/events` and `/v1/resources` | `limit` query param — integer 1–200, default 100 | Results sliced after ordering |
| `lat`/`lon` on `/v1/events` | Must be provided together; blank values (`?lat=`) read as absent, never as `0` | `400` naming the actual failing fields |
| SSE connections | 200 concurrent process-wide, 5 per client | `503` (global) or `429` (per-client) `{"error":"too_many_streams"}` |
| SSE per-connection buffer | 500 pending events | Buffer cleared; one `resync` frame (`{"reason":"buffer_overflow"}`) tells the client to refetch `/v1/events` |
| Unroutable candidates | `risk_score` is always finite | `no_path` candidates carry `Number.MAX_SAFE_INTEGER`, never `null` |
| `/v1/health` `last_error` | Redacted to `"timeout" \| "upstream_error" \| "bad_payload" \| null` | Full upstream error text is server-log only |
| CORS | `ALLOWED_ORIGINS` env (comma-separated, exact match). Unset: localhost-only in dev, deny-all cross-origin in production | No `Access-Control-Allow-Origin` header |
| Concurrent LLM compositions | 4 in flight | Additional requests get the deterministic composer (same evidence, plainer prose) |
| Security headers | `secureHeaders` with `default-src 'none'; frame-ancestors 'none'` CSP + `nosniff` on every response | — |

Error bodies for query validation carry `{ "error": "invalid_query", "message": "...",
"issues": [{ "path": "lat", "code": "invalid_type" }] }` — field paths and Zod codes
only, never echoed input.

---

## `GET /v1/health`

Service liveness plus the state of every ingestion source. This is the endpoint to read
first when data looks wrong — see [RUNBOOK.md](./RUNBOOK.md#checking-source-health).

**Query parameters:** none.

**Response `200`** — `sources` is `SourceHealth[]` from `@harborline/event-schema`.

```bash
curl -s http://localhost:8787/v1/health | jq
```

```json
{
  "status": "ok",
  "uptime_s": 1284,
  "sources": [
    {
      "id": "demo",
      "label": "Demo scenario fixtures",
      "healthy": true,
      "last_success_at": "2026-08-02T18:18:16Z",
      "last_error": null,
      "consecutive_failures": 0,
      "circuit_open": false
    },
    {
      "id": "nws",
      "label": "NOAA National Weather Service — active alerts (CA)",
      "healthy": true,
      "last_success_at": "2026-08-02T18:39:04Z",
      "last_error": null,
      "consecutive_failures": 0,
      "circuit_open": false
    },
    {
      "id": "usgs",
      "label": "USGS earthquakes M2.5+ past week",
      "healthy": true,
      "last_success_at": "2026-08-02T18:35:41Z",
      "last_error": null,
      "consecutive_failures": 0,
      "circuit_open": false
    },
    {
      "id": "fema-shelters",
      "label": "FEMA / American Red Cross open shelters",
      "healthy": false,
      "last_success_at": "2026-08-02T16:52:10Z",
      "last_error": "upstream responded 503",
      "consecutive_failures": 4,
      "circuit_open": true
    }
  ]
}
```

`status` is `"ok"` when at least one source is healthy and `"degraded"` when every source
has an open circuit. The service does not return `"down"` — if it cannot answer, it is not
answering. The presence of a healthy `demo` source is how you confirm `DEMO_MODE=1` took
effect.

---

## `GET /v1/events`

Active canonical events, ordered by **severity descending, then freshness** (most recently
verified first).

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `lat` | number `-90..90` | no | none | Query center latitude; must be provided together with `lon`. Omitting both returns the full active feed |
| `lon` | number `-180..180` | no | none | Query center longitude |
| `radius_m` | number `> 0` | no | `5000` | Radius in meters; applies only when a center is given |
| `types` | comma-separated `EventType` | no | all types | e.g. `fire,road_closure` |

```bash
curl -s "http://localhost:8787/v1/events?lat=39.7398&lon=-121.8432&radius_m=3000&types=fire,road_closure" | jq
```

**Response `200`**

```json
{
  "events": [
    {
      "event_id": "calfire-fire-east-chico-20260802",
      "event_type": "fire",
      "headline": "Evacuation Warning — wind-driven vegetation fire east of the Avenues",
      "description": "A wind-driven vegetation fire is burning west toward the Mangrove Ave corridor. Spot fires and heavy smoke are reported east of Mangrove Ave, and red flag winds are expected to continue through the evening.",
      "instructions": "Prepare to leave now and evacuate if you feel unsafe — do not wait for a mandatory order. Stay out of the area east of Mangrove Ave. Do not drive through smoke; downed power lines may be energized.",
      "severity": "severe",
      "urgency": "immediate",
      "certainty": "observed",
      "status": "active",
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [-121.8365, 39.7380],
            [-121.8320, 39.7380],
            [-121.8320, 39.7550],
            [-121.8365, 39.7550],
            [-121.8365, 39.7380]
          ]
        ]
      },
      "starts_at": "2026-08-02T17:55:00Z",
      "ends_at": null,
      "last_verified_at": "2026-08-02T18:36:00Z",
      "source_count": 2,
      "best_tier": "A",
      "confidence_score": 0.91,
      "confidence_label": "official",
      "contradiction_note": null
    },
    {
      "event_id": "cpw-closure-oleander-ave-20260802",
      "event_type": "road_closure",
      "headline": "Oleander Ave closed between E 3rd Ave and E 5th Ave",
      "description": "Full closure in both directions after red flag winds brought down power lines across the roadway. No estimated reopening time.",
      "instructions": null,
      "severity": "severe",
      "urgency": "immediate",
      "certainty": "observed",
      "status": "active",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [-121.8425, 39.7435],
          [-121.8425, 39.7465]
        ]
      },
      "starts_at": "2026-08-02T17:10:00Z",
      "ends_at": null,
      "last_verified_at": "2026-08-02T18:18:00Z",
      "source_count": 1,
      "best_tier": "B",
      "confidence_score": 0.51,
      "confidence_label": "developing",
      "contradiction_note": "Chico Public Works reports this segment closed (verified 22 min ago). An unverified social report at 18:29Z claims traffic is moving. The official closure stands; the dispute is shown, not merged."
    },
    {
      "event_id": "cpw-closure-mangrove-ave-20260802",
      "event_type": "road_closure",
      "headline": "Mangrove Ave closed between E 5th Ave and E 7th Ave",
      "description": "Northbound and southbound lanes closed for fire apparatus staging.",
      "instructions": null,
      "severity": "moderate",
      "urgency": "expected",
      "certainty": "observed",
      "status": "active",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [-121.8350, 39.7465],
          [-121.8350, 39.7495]
        ]
      },
      "starts_at": "2026-08-02T16:40:00Z",
      "ends_at": null,
      "last_verified_at": "2026-08-02T18:05:00Z",
      "source_count": 1,
      "best_tier": "B",
      "confidence_score": 0.71,
      "confidence_label": "verified",
      "contradiction_note": null
    }
  ]
}
```

Reading the confidence numbers against
[the formula](./ARCHITECTURE.md#6-confidence-formula-and-label-gating): the fire is tier A,
4 minutes old against a 1-hour policy, corroborated by two sources → `0.91`, `official`.
The Oleander Ave closure is tier B with a single source and an active tier E dispute pulling
`consistency` down → `0.51`, `developing`. **The label drop does not weaken the closure**:
elimination in the router keys on `event_type` and `status`, not on the label, so this
closure still eliminates any route crossing it.

---

## `GET /v1/events/:id`

One event plus **every** source record that contributed to it. Provenance is never merged
away, so a two-source event returns two records, and a disputed event returns the disputing
record too.

```bash
curl -s http://localhost:8787/v1/events/cpw-closure-oleander-ave-20260802 | jq
```

**Response `200`**

```json
{
  "event": {
    "event_id": "cpw-closure-oleander-ave-20260802",
    "event_type": "road_closure",
    "headline": "Oleander Ave closed between E 3rd Ave and E 5th Ave",
    "severity": "severe",
    "status": "active",
    "last_verified_at": "2026-08-02T18:18:00Z",
    "source_count": 1,
    "best_tier": "B",
    "confidence_score": 0.51,
    "confidence_label": "developing",
    "contradiction_note": "Chico Public Works reports this segment closed (verified 22 min ago). An unverified social report at 18:29Z claims traffic is moving. The official closure stands; the dispute is shown, not merged."
  },
  "source_records": [
    {
      "source_record_id": "src-cpw-8841",
      "event_id": "cpw-closure-oleander-ave-20260802",
      "provider": "Chico Public Works",
      "provider_record_id": "CPW-2026-08-02-0117",
      "provider_tier": "B",
      "source_url": "https://chico.ca.us/publicworks/closures/CPW-2026-08-02-0117",
      "published_at": "2026-08-02T17:10:00Z",
      "retrieved_at": "2026-08-02T18:18:00Z",
      "content_hash": "6f1c0a2e"
    },
    {
      "source_record_id": "src-social-2210",
      "event_id": "cpw-closure-oleander-ave-20260802",
      "provider": "Unverified social report",
      "provider_record_id": "post-77120",
      "provider_tier": "E",
      "source_url": null,
      "published_at": "2026-08-02T18:29:00Z",
      "retrieved_at": "2026-08-02T18:31:00Z",
      "content_hash": "b2d94e17"
    }
  ]
}
```

The `event` object is a full `CanonicalEvent`; fields are elided above for brevity only.

**Response `404`** when the id is unknown — see [Errors](#errors).

---

## `GET /v1/resources`

Nearby resources, each enriched with `distance_m` (`NearbyResource`), sorted by distance
ascending.

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `lat` | number | yes | — | Query center latitude |
| `lon` | number | yes | — | Query center longitude |
| `radius_m` | number | no | `10000` | Radius in meters |
| `type` | `ResourceType` | no | all | `shelter`, `hospital`, `cooling_center`, `food_water`, `charging`, `transport_hub` |
| `status` | `OperationalStatus` | no | all | `open`, `closed`, `full`, `unknown` |

> [!IMPORTANT]
> This endpoint returns **everything matching the filter, including stale records** — the
> UI must be able to show a shelter and the fact that its status is 26 hours old. Stale
> filtering is a *recommendation* concern: `get_nearby_resources` in the tool layer and the
> assistant pipeline exclude records past `FRESHNESS_POLICY.resources[type]`. Compare
> `last_verified_at` against the policy before treating a record here as current.

```bash
curl -s "http://localhost:8787/v1/resources?lat=39.7398&lon=-121.8432&type=shelter" | jq
```

**Response `200`**

```json
{
  "resources": [
    {
      "resource_id": "demo-shelter-chico-community-center",
      "resource_type": "shelter",
      "name": "Chico Community Center",
      "location": { "type": "Point", "coordinates": [-121.8460, 39.7405] },
      "address": "The Esplanade & E 1st Ave, Chico, CA 95926",
      "operational_status": "full",
      "capacity_total": 180,
      "capacity_available": 0,
      "accessibility_features": ["wheelchair_accessible"],
      "pet_policy": "Service animals only",
      "contact_information": "(530) 555-0163",
      "last_verified_at": "2026-08-02T18:25:00Z",
      "provider": "Butte County Emergency Management",
      "provider_tier": "B",
      "source_url": "https://demo.harborline.local/shelters/chico-community-center",
      "distance_m": 253
    },
    {
      "resource_id": "demo-shelter-neighborhood-church",
      "resource_type": "shelter",
      "name": "Neighborhood Church",
      "location": { "type": "Point", "coordinates": [-121.8460, 39.7525] },
      "address": "The Esplanade & E 9th Ave, Chico, CA 95926",
      "operational_status": "open",
      "capacity_total": 200,
      "capacity_available": 120,
      "accessibility_features": ["wheelchair_accessible", "accessible_restrooms"],
      "pet_policy": "Pets allowed (leashed or crated)",
      "contact_information": "(530) 555-0142",
      "last_verified_at": "2026-08-02T18:32:00Z",
      "provider": "Butte County Emergency Management",
      "provider_tier": "B",
      "source_url": "https://demo.harborline.local/shelters/neighborhood-church",
      "distance_m": 1432
    },
    {
      "resource_id": "demo-shelter-bidwell-community-center",
      "resource_type": "shelter",
      "name": "Bidwell Community Center",
      "location": { "type": "Point", "coordinates": [-121.8350, 39.7510] },
      "address": "Mangrove Ave & E 9th Ave, Chico, CA 95926",
      "operational_status": "open",
      "capacity_total": 150,
      "capacity_available": 40,
      "accessibility_features": ["wheelchair_accessible"],
      "pet_policy": "Service animals only",
      "contact_information": "(530) 555-0177",
      "last_verified_at": "2026-08-01T16:40:00Z",
      "provider": "Butte County Emergency Management",
      "provider_tier": "B",
      "source_url": "https://demo.harborline.local/shelters/bidwell-community-center",
      "distance_m": 1447
    }
  ]
}
```

Bidwell's `last_verified_at` is **26 hours** old against a 24-hour shelter policy. It is
returned here with its timestamp so the map can render it honestly, and it is rejected by
the assistant's resource tool with `rejected_reason: "stale_status"`.

The resource tool's full rejection vocabulary is `stale_status`, `full`, `closed`, and
`inside_hazard_zone`. The last one is the Feather River rule from the Camp Fire benchmark
([BENCHMARK.md](./BENCHMARK.md)): a fresh, open facility whose location falls inside the
geometry of an active severe-or-extreme hazard is rejected outright — its own status
record does not save it.

---

## `GET /v1/resources/:id`

One resource plus its provenance and freshness verdict. This is the same
structure the assistant's `get_resource_status` tool sees — the API and the
assistant never disagree about a shelter.

```bash
curl -s http://localhost:8787/v1/resources/demo-shelter-neighborhood-church | jq
```

**Response `200`**

```json
{
  "resource": {
    "resource_id": "demo-shelter-neighborhood-church",
    "resource_type": "shelter",
    "name": "Neighborhood Church",
    "location": { "type": "Point", "coordinates": [-121.8460, 39.7525] },
    "operational_status": "open",
    "capacity_total": 200,
    "capacity_available": 120,
    "last_verified_at": "2026-08-02T18:32:00Z",
    "provider": "Butte County Emergency Management",
    "provider_tier": "B",
    "source_url": "https://demo.harborline.local/shelters/neighborhood-church"
  },
  "provider": "Butte County Emergency Management",
  "provider_tier": "B",
  "source_url": "https://demo.harborline.local/shelters/neighborhood-church",
  "last_verified_at": "2026-08-02T18:32:00Z",
  "age_seconds": 240,
  "age_label": "4 min ago",
  "max_age_seconds": 86400,
  "stale": false
}
```

`event_id` is `null` on resource-derived source records — the record attaches to a
resource, not an event.

---

## `GET /v1/routes`

Runs the [route-risk pipeline](./ARCHITECTURE.md#8-route-risk-pipeline) from a point to a
resource. Returns **all** candidates, including eliminated ones with their rejection
reason, plus the recommendation (or `null` when nothing survives).

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `from_lat` | number | yes | Origin latitude |
| `from_lon` | number | yes | Origin longitude |
| `to_resource_id` | string | yes | Destination resource id |

```bash
curl -s "http://localhost:8787/v1/routes?from_lat=39.7398&from_lon=-121.8432&to_resource_id=demo-shelter-neighborhood-church" | jq
```

**Response `200`**

```json
{
  "candidates": [
    {
      "route_id": "route_1",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [-121.8432, 39.7398],
          [-121.8425, 39.7405],
          [-121.8425, 39.7435],
          [-121.8425, 39.7465],
          [-121.8425, 39.7495],
          [-121.8425, 39.7525],
          [-121.8460, 39.7525]
        ]
      },
      "distance_m": 1731,
      "duration_min": 3.5,
      "hazard_exposure_m": 0,
      "intersecting_event_ids": ["cpw-closure-oleander-ave-20260802"],
      "risk_score": 3.46,
      "eliminated": true,
      "rejected_reason": "closure_intersection"
    },
    {
      "route_id": "route_2",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [-121.8432, 39.7398],
          [-121.8425, 39.7405],
          [-121.8460, 39.7405],
          [-121.8460, 39.7435],
          [-121.8460, 39.7465],
          [-121.8460, 39.7495],
          [-121.8460, 39.7525]
        ]
      },
      "distance_m": 1732,
      "duration_min": 3.5,
      "hazard_exposure_m": 0,
      "intersecting_event_ids": [],
      "risk_score": 3.46,
      "eliminated": false,
      "rejected_reason": null
    },
    {
      "route_id": "route_3",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [-121.8432, 39.7398],
          [-121.8425, 39.7405],
          [-121.8390, 39.7405],
          [-121.8390, 39.7435],
          [-121.8390, 39.7465],
          [-121.8390, 39.7495],
          [-121.8390, 39.7525],
          [-121.8425, 39.7525],
          [-121.8460, 39.7525]
        ]
      },
      "distance_m": 2331,
      "duration_min": 4.7,
      "hazard_exposure_m": 0,
      "intersecting_event_ids": [],
      "risk_score": 4.66,
      "eliminated": false,
      "rejected_reason": null
    }
  ],
  "recommendation": {
    "recommendation_id": "rec_demo-shelter-neighborhood-church_1785758400000",
    "route_id": "route_2",
    "destination_resource_id": "demo-shelter-neighborhood-church",
    "summary": "Lowest-risk route currently available to Neighborhood Church — 3 min, avoids 3 reported hazards. Conditions may change.",
    "duration_min": 3.5,
    "avoided_hazard_count": 3,
    "evidence_event_ids": [
      "calfire-fire-east-chico-20260802",
      "cpw-closure-oleander-ave-20260802",
      "cpw-closure-mangrove-ave-20260802"
    ],
    "generated_at": "2026-08-02T18:40:00Z",
    "expires_at": "2026-08-02T18:50:00Z",
    "routing": "demonstration"
  }
}
```

Three things this response is contractually required to do:

- **`routing` is always the literal `"demonstration"`.** `RouteRecommendation.routing` is
  `z.literal("demonstration")` in the schema — a response without it does not type-check
  and does not validate.
- **`summary` never says "safe".** The phrasing is "lowest-risk route currently available".
  Violation class 3 of the safety validator rejects guarantee language independently.
- **Eliminated candidates are returned, not hidden.** `route_1` is the naively shortest path
  and it is exactly the one running up Oleander Ave through the closure. Showing the
  rejection is the evidence that the elimination happened.

When every candidate is eliminated, `recommendation` is `null` and the candidate list
carries the reasons. Clients must render that as "no route we can recommend right now",
never fall back to the shortest path.

---

## `POST /v1/assistant/ask`

Runs the [assistant pipeline](./ARCHITECTURE.md#9-assistant-pipeline):
`planQuery` → tools → compose → validate → deterministic fallback on rejection.

**Request body** (`AssistantAsk`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `question` | string, 1–500 chars | yes | Natural language |
| `lat` | number `-90..90` | yes | User location latitude |
| `lon` | number `-180..180` | yes | User location longitude |

```bash
curl -s -X POST http://localhost:8787/v1/assistant/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"Where is the nearest open shelter?","lat":39.7398,"lon":-121.8432}' | jq
```

**Response `200`** (`AssistantResponse`)

```json
{
  "answer_markdown": "**Neighborhood Church** is the nearest shelter currently reported open — about 1.4 km away at The Esplanade & E 9th Ave. Butte County Emergency Management verified its status 8 minutes ago: open, with 120 of 200 spaces available.\n\nTwo other shelters were considered and set aside:\n\n- **Chico Community Center** (0.3 km) — reported **full** as of 15 minutes ago.\n- **Bidwell Community Center** (1.4 km) — its status was last verified 26 hours ago, which is past the 24-hour freshness limit for shelters. It may well be open; we cannot say that it is.",
  "recommended_action": "Head to Neighborhood Church, The Esplanade & E 9th Ave. Call (530) 555-0142 before travelling to confirm space is still available.",
  "sources": [
    {
      "provider": "Butte County Emergency Management",
      "tier": "B",
      "url": "https://demo.harborline.local/shelters/neighborhood-church",
      "last_verified_at": "2026-08-02T18:32:00Z"
    },
    {
      "provider": "Butte County Emergency Management",
      "tier": "B",
      "url": "https://demo.harborline.local/shelters/chico-community-center",
      "last_verified_at": "2026-08-02T18:25:00Z"
    }
  ],
  "freshness_note": "Shelter status verified 8 min ago. Shelter records are considered stale after 24 h and are then excluded from recommendations.",
  "uncertainty_note": "Shelter capacity changes faster than the feed updates. Bidwell Community Center was excluded because its status is 26 h old, not because it is closed.",
  "evidence_event_ids": ["calfire-fire-east-chico-20260802"],
  "composed_by": "deterministic"
}
```

`composed_by` is `"deterministic"` when the template composer produced the text and
`"llm"` when `llmCompose` did. **A rejected LLM answer is never returned** — the service
falls back to `composeResponse` and the field reads `"deterministic"`, so the value always
describes the text you actually received. See
[RUNBOOK.md](./RUNBOOK.md#enabling-the-optional-llm-composer).

---

## `GET /v1/stream` (Server-Sent Events)

A long-lived SSE connection that emits on every store upsert. Content type is
`text/event-stream`; the connection does not close on its own.

| Event name | `data` payload |
|---|---|
| `feed_update` | One `CanonicalEvent` (JSON) |
| `resync` | `{"reason":"buffer_overflow"}` — the client fell too far behind and its backlog was dropped; refetch `GET /v1/events` |

Keep-alive is an SSE **comment line** (`: heartbeat`), written every 25 s of
write inactivity. Comments carry no event name and no data — `EventSource`
ignores them automatically; raw-stream consumers should skip lines beginning
with `:`.

The service also caps concurrent streams: 200 process-wide (`503
too_many_streams`) and 5 per client (`429 too_many_streams`).

### curl

```bash
curl -N -H 'Accept: text/event-stream' http://localhost:8787/v1/stream
```

```
: heartbeat

event: feed_update
id: cpw-closure-oleander-ave-20260802:2026-08-02T18:18:00Z
data: {"event_id":"cpw-closure-oleander-ave-20260802","event_type":"road_closure","headline":"Oleander Ave closed between E 3rd Ave and E 5th Ave","severity":"severe","status":"active","last_verified_at":"2026-08-02T18:18:00Z","source_count":1,"best_tier":"B","confidence_score":0.51,"confidence_label":"developing"}

: heartbeat
```

`-N` disables curl's buffering; without it nothing appears until the buffer fills.

### EventSource

```ts
import { CanonicalEventSchema, type CanonicalEvent } from "@harborline/event-schema";

const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const es = new EventSource(`${base}/v1/stream`);

es.addEventListener("feed_update", (e) => {
  // Validate at the boundary — SSE data is untrusted text until parsed.
  const parsed = CanonicalEventSchema.safeParse(JSON.parse(e.data));
  if (!parsed.success) return;
  const event: CanonicalEvent = parsed.data;
  queryClient.setQueryData<{ events: CanonicalEvent[] }>(["events"], (prev) => {
    if (!prev) return { events: [event] };
    const rest = prev.events.filter((x) => x.event_id !== event.event_id);
    return { events: [event, ...rest] };
  });
});

es.onerror = () => {
  // EventSource reconnects on its own; close and re-open only on a hard failure.
  if (es.readyState === EventSource.CLOSED) scheduleReconnect();
};
```

The stream is an **update channel, not the source of truth**. Load initial state from
`GET /v1/events`, then merge `feed_update` payloads into it. On reconnect, refetch — events
emitted while disconnected are not replayed.

---

## Errors

Every non-2xx response uses one flat shape — an `error` slug, a human-readable
`message`, and (for validation failures) an `issues` array:

```json
{
  "error": "invalid_query",
  "message": "Query parameters failed validation.",
  "issues": [
    { "path": "lat", "code": "too_big" },
    { "path": "radius_m", "code": "invalid_type" }
  ]
}
```

| Status | `error` | When |
|---|---|---|
| `400` | `invalid_query` | Zod rejected a query parameter. `issues` carries the field paths and codes. |
| `400` | `invalid_body` | Zod rejected a request body. |
| `404` | `not_found` | Unknown or malformed `event_id`/`resource_id`, or an unknown route. |
| `413` | `payload_too_large` | Request body exceeded the body limit. |
| `422` | `no_viable_route` | `/v1/routes` could not produce a recommendation — either the origin/destination could not snap to the bounded demo graph, or every candidate route was eliminated by an active closure. |
| `429` | `rate_limited` | Token bucket exhausted (120/min general, 6/min assistant). `Retry-After` is set. |
| `429`/`503` | `too_many_streams` | Per-client (429) or process-wide (503) SSE cap reached. |
| `500` | `unsafe_response` | The assistant could not produce an answer satisfying the safety policy. |
| `500` | `internal_error` | Unexpected failure. `issues` is omitted. |

`issues` is present only on validation failures, and deliberately carries paths
and codes but not expected/received details. The `message` field is
human-readable and may change; **branch on `error`, never on `message`**.

Two deliberate non-errors:

- **A source with an open circuit is not an error.** Requests still succeed against the
  records already in the store; the degradation is visible at `/v1/health`.
- **No matching records is not an error.** `/v1/events` and `/v1/resources` return `200`
  with an empty array. An empty result means "nothing verified in range", which is a fact,
  not a failure.
