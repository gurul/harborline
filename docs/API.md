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
> All examples below use the **demo scenario** seeded by `DEMO_MODE=1` — a Capitol Hill
> flood warning, two SDOT closures (one on 12th Ave), and three shelters including Calvary
> Church. Demo fixtures are synthetic: the coordinates are real Seattle geography, the
> facilities and incidents are not. Example responses are rendered as of a fixed
> `now = 2026-08-02T18:40:00Z`, so ages and confidence scores are reproducible.

---

## Endpoint index

| Method | Path | Returns |
|---|---|---|
| `GET` | `/v1/health` | Service status and per-source ingestion health |
| `GET` | `/v1/events` | Active canonical events near a point |
| `GET` | `/v1/events/:id` | One event plus all its source records |
| `GET` | `/v1/resources` | Nearby resources with `distance_m` |
| `GET` | `/v1/resources/:id` | One resource plus all its source records |
| `GET` | `/v1/routes` | Route candidates and a recommendation |
| `POST` | `/v1/assistant/ask` | An `AssistantResponse` |
| `GET` | `/v1/stream` | Server-Sent Events on every store upsert |

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
      "label": "NOAA National Weather Service — active alerts (WA)",
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
| `lat` | number `-90..90` | no | Seattle center `47.6062` | Query center latitude |
| `lon` | number `-180..180` | no | Seattle center `-122.3321` | Query center longitude |
| `radius_m` | number `> 0` | no | `10000` | Radius in meters |
| `types` | comma-separated `EventType` | no | all types | e.g. `flood,road_closure` |

```bash
curl -s "http://localhost:8787/v1/events?lat=47.6145&lon=-122.3180&radius_m=3000&types=flood,road_closure" | jq
```

**Response `200`**

```json
{
  "events": [
    {
      "event_id": "nws-wa-flood-20260802-0143",
      "event_type": "flood",
      "headline": "Flood Warning — Capitol Hill and Central District",
      "description": "Rapid street flooding reported along the Capitol Hill drainage basin. Water over roadway at multiple intersections. Do not drive through standing water.",
      "instructions": "Move to higher ground. Avoid walking or driving through flood waters. Follow instructions from local officials.",
      "severity": "severe",
      "urgency": "immediate",
      "certainty": "observed",
      "status": "active",
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [-122.3230, 47.6100],
            [-122.3080, 47.6100],
            [-122.3080, 47.6215],
            [-122.3230, 47.6215],
            [-122.3230, 47.6100]
          ]
        ]
      },
      "starts_at": "2026-08-02T17:05:00Z",
      "ends_at": "2026-08-03T02:00:00Z",
      "last_verified_at": "2026-08-02T18:32:00Z",
      "source_count": 2,
      "best_tier": "A",
      "confidence_score": 0.91,
      "confidence_label": "official",
      "contradiction_note": null
    },
    {
      "event_id": "sdot-closure-12th-ave-20260802",
      "event_type": "road_closure",
      "headline": "12th Ave closed between E Pike St and E Madison St",
      "description": "Full closure in both directions due to standing water and a compromised storm drain. No estimated reopening time.",
      "instructions": null,
      "severity": "moderate",
      "urgency": "immediate",
      "certainty": "observed",
      "status": "active",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [-122.3168, 47.6110],
          [-122.3168, 47.6185]
        ]
      },
      "starts_at": "2026-08-02T17:40:00Z",
      "ends_at": null,
      "last_verified_at": "2026-08-02T18:18:00Z",
      "source_count": 1,
      "best_tier": "B",
      "confidence_score": 0.51,
      "confidence_label": "developing",
      "contradiction_note": "Seattle DOT reports this segment closed (verified 22 min ago). An unverified social report at 18:29Z claims traffic is moving. The official closure stands; the dispute is shown, not merged."
    },
    {
      "event_id": "sdot-closure-e-union-20260802",
      "event_type": "road_closure",
      "headline": "E Union St closed between 14th Ave and 23rd Ave",
      "description": "Eastbound and westbound lanes closed for flood response staging.",
      "instructions": null,
      "severity": "moderate",
      "urgency": "expected",
      "certainty": "observed",
      "status": "active",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [-122.3210, 47.6135],
          [-122.3090, 47.6135]
        ]
      },
      "starts_at": "2026-08-02T17:55:00Z",
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
[the formula](./ARCHITECTURE.md#6-confidence-formula-and-label-gating): the flood is tier A,
8 minutes old against a 2-hour policy, corroborated by two sources → `0.91`, `official`.
The 12th Ave closure is tier B with a single source and an active tier E dispute pulling
`consistency` down → `0.51`, `developing`. **The label drop does not weaken the closure**:
elimination in the router keys on `event_type` and `status`, not on the label, so this
closure still eliminates any route crossing it.

---

## `GET /v1/events/:id`

One event plus **every** source record that contributed to it. Provenance is never merged
away, so a two-source event returns two records, and a disputed event returns the disputing
record too.

```bash
curl -s http://localhost:8787/v1/events/sdot-closure-12th-ave-20260802 | jq
```

**Response `200`**

```json
{
  "event": {
    "event_id": "sdot-closure-12th-ave-20260802",
    "event_type": "road_closure",
    "headline": "12th Ave closed between E Pike St and E Madison St",
    "severity": "moderate",
    "status": "active",
    "last_verified_at": "2026-08-02T18:18:00Z",
    "source_count": 1,
    "best_tier": "B",
    "confidence_score": 0.51,
    "confidence_label": "developing",
    "contradiction_note": "Seattle DOT reports this segment closed (verified 22 min ago). An unverified social report at 18:29Z claims traffic is moving. The official closure stands; the dispute is shown, not merged."
  },
  "source_records": [
    {
      "source_record_id": "src-sdot-8841",
      "event_id": "sdot-closure-12th-ave-20260802",
      "provider": "Seattle DOT",
      "provider_record_id": "TRV-2026-08-02-0117",
      "provider_tier": "B",
      "source_url": "https://web.seattle.gov/travelers/incident/TRV-2026-08-02-0117",
      "published_at": "2026-08-02T17:40:00Z",
      "retrieved_at": "2026-08-02T18:18:00Z",
      "content_hash": "sha256:6f1c0a…"
    },
    {
      "source_record_id": "src-social-2210",
      "event_id": "sdot-closure-12th-ave-20260802",
      "provider": "Unverified social report",
      "provider_record_id": "post-77120",
      "provider_tier": "E",
      "source_url": null,
      "published_at": "2026-08-02T18:29:00Z",
      "retrieved_at": "2026-08-02T18:31:00Z",
      "content_hash": "sha256:b2d94e…"
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
| `lat` | number | no | `47.6062` | Query center latitude |
| `lon` | number | no | `-122.3321` | Query center longitude |
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
curl -s "http://localhost:8787/v1/resources?lat=47.6145&lon=-122.3180&type=shelter" | jq
```

**Response `200`**

```json
{
  "resources": [
    {
      "resource_id": "shelter-calvary-church",
      "resource_type": "shelter",
      "name": "Calvary Church Emergency Shelter",
      "location": { "type": "Point", "coordinates": [-122.3095, 47.6242] },
      "address": "1120 E Aloha St, Seattle, WA 98102",
      "operational_status": "open",
      "capacity_total": 120,
      "capacity_available": 47,
      "accessibility_features": ["wheelchair_accessible", "accessible_restrooms", "cots"],
      "pet_policy": "Leashed or crated pets accepted",
      "contact_information": "(206) 555-0142",
      "last_verified_at": "2026-08-02T18:32:00Z",
      "provider": "American Red Cross",
      "provider_tier": "B",
      "source_url": "https://gis.fema.gov/arcgis/shelters/calvary-church",
      "distance_m": 1254
    },
    {
      "resource_id": "shelter-miller-community-center",
      "resource_type": "shelter",
      "name": "Miller Community Center",
      "location": { "type": "Point", "coordinates": [-122.3155, 47.6262] },
      "address": "330 19th Ave E, Seattle, WA 98112",
      "operational_status": "full",
      "capacity_total": 80,
      "capacity_available": 0,
      "accessibility_features": ["wheelchair_accessible"],
      "pet_policy": "Service animals only",
      "contact_information": "(206) 555-0188",
      "last_verified_at": "2026-08-02T18:11:00Z",
      "provider": "American Red Cross",
      "provider_tier": "B",
      "source_url": "https://gis.fema.gov/arcgis/shelters/miller-cc",
      "distance_m": 1313
    },
    {
      "resource_id": "shelter-garfield-community-center",
      "resource_type": "shelter",
      "name": "Garfield Community Center",
      "location": { "type": "Point", "coordinates": [-122.3018, 47.6060] },
      "address": "2323 E Cherry St, Seattle, WA 98122",
      "operational_status": "open",
      "capacity_total": 150,
      "capacity_available": null,
      "accessibility_features": ["wheelchair_accessible", "cots"],
      "pet_policy": null,
      "contact_information": "(206) 555-0130",
      "last_verified_at": "2026-08-01T16:40:00Z",
      "provider": "American Red Cross",
      "provider_tier": "B",
      "source_url": "https://gis.fema.gov/arcgis/shelters/garfield-cc",
      "distance_m": 1538
    }
  ]
}
```

Garfield's `last_verified_at` is **26 hours** old against a 24-hour shelter policy. It is
returned here with its timestamp so the map can render it honestly, and it is rejected by
the assistant's resource tool with `rejected_reason: "stale_status"`.

---

## `GET /v1/resources/:id`

One resource plus its source records.

```bash
curl -s http://localhost:8787/v1/resources/shelter-calvary-church | jq
```

**Response `200`**

```json
{
  "resource": {
    "resource_id": "shelter-calvary-church",
    "resource_type": "shelter",
    "name": "Calvary Church Emergency Shelter",
    "location": { "type": "Point", "coordinates": [-122.3095, 47.6242] },
    "operational_status": "open",
    "capacity_total": 120,
    "capacity_available": 47,
    "last_verified_at": "2026-08-02T18:32:00Z",
    "provider": "American Red Cross",
    "provider_tier": "B",
    "source_url": "https://gis.fema.gov/arcgis/shelters/calvary-church"
  },
  "source_records": [
    {
      "source_record_id": "src-arc-4417",
      "event_id": null,
      "provider": "American Red Cross",
      "provider_record_id": "SHELTER-WA-KING-0142",
      "provider_tier": "B",
      "source_url": "https://gis.fema.gov/arcgis/shelters/calvary-church",
      "published_at": "2026-08-02T18:32:00Z",
      "retrieved_at": "2026-08-02T18:36:00Z",
      "content_hash": "sha256:04ae71…"
    }
  ]
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
curl -s "http://localhost:8787/v1/routes?from_lat=47.6145&from_lon=-122.3180&to_resource_id=shelter-calvary-church" | jq
```

**Response `200`**

```json
{
  "candidates": [
    {
      "route_id": "route-a",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [-122.3180, 47.6145],
          [-122.3168, 47.6145],
          [-122.3168, 47.6185],
          [-122.3120, 47.6205],
          [-122.3095, 47.6242]
        ]
      },
      "distance_m": 1610,
      "duration_min": 6.4,
      "hazard_exposure_m": 740,
      "intersecting_event_ids": [
        "sdot-closure-12th-ave-20260802",
        "nws-wa-flood-20260802-0143"
      ],
      "risk_score": 0,
      "eliminated": true,
      "rejected_reason": "closure_intersection"
    },
    {
      "route_id": "route-b",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [-122.3180, 47.6145],
          [-122.3180, 47.6198],
          [-122.3140, 47.6221],
          [-122.3095, 47.6242]
        ]
      },
      "distance_m": 1845,
      "duration_min": 8.1,
      "hazard_exposure_m": 260,
      "intersecting_event_ids": ["nws-wa-flood-20260802-0143"],
      "risk_score": 14.7,
      "eliminated": false,
      "rejected_reason": null
    },
    {
      "route_id": "route-c",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [-122.3180, 47.6145],
          [-122.3222, 47.6160],
          [-122.3210, 47.6228],
          [-122.3095, 47.6242]
        ]
      },
      "distance_m": 2310,
      "duration_min": 9.8,
      "hazard_exposure_m": 0,
      "intersecting_event_ids": [],
      "risk_score": 16.2,
      "eliminated": false,
      "rejected_reason": null
    }
  ],
  "recommendation": {
    "recommendation_id": "rec-20260802-1840-01",
    "route_id": "route-b",
    "destination_resource_id": "shelter-calvary-church",
    "summary": "Lowest-risk route currently available to Calvary Church Emergency Shelter — about 8 min, avoiding 2 hazards. One alternative was eliminated because it crosses an active Seattle DOT closure on 12th Ave.",
    "duration_min": 8.1,
    "avoided_hazard_count": 2,
    "evidence_event_ids": [
      "nws-wa-flood-20260802-0143",
      "sdot-closure-12th-ave-20260802",
      "sdot-closure-e-union-20260802"
    ],
    "generated_at": "2026-08-02T18:40:00Z",
    "expires_at": "2026-08-02T19:10:00Z",
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
- **Eliminated candidates are returned, not hidden.** `route-a` is the naively shortest path
  and it is exactly the one crossing the 12th Ave closure. Showing the rejection is the
  evidence that the elimination happened.

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
  -d '{"question":"Where is the nearest open shelter?","lat":47.6145,"lon":-122.3180}' | jq
```

**Response `200`** (`AssistantResponse`)

```json
{
  "answer_markdown": "**Calvary Church Emergency Shelter** is the nearest shelter currently reported open — about 1.3 km away at 1120 E Aloha St. The American Red Cross verified its status 8 minutes ago: open, with 47 of 120 spaces available.\n\nTwo other shelters were considered and set aside:\n\n- **Miller Community Center** (1.3 km) — reported **full** as of 29 minutes ago.\n- **Garfield Community Center** (1.5 km) — its status was last verified 26 hours ago, which is past the 24-hour freshness limit for shelters. It may well be open; we cannot say that it is.",
  "recommended_action": "Head to Calvary Church Emergency Shelter, 1120 E Aloha St. Call (206) 555-0142 before travelling to confirm space is still available.",
  "sources": [
    {
      "provider": "American Red Cross",
      "tier": "B",
      "url": "https://gis.fema.gov/arcgis/shelters/calvary-church",
      "last_verified_at": "2026-08-02T18:32:00Z"
    },
    {
      "provider": "American Red Cross",
      "tier": "B",
      "url": "https://gis.fema.gov/arcgis/shelters/miller-cc",
      "last_verified_at": "2026-08-02T18:11:00Z"
    }
  ],
  "freshness_note": "Shelter status verified 8 min ago. Shelter records are considered stale after 24 h and are then excluded from recommendations.",
  "uncertainty_note": "Shelter capacity changes faster than the feed updates. Garfield Community Center was excluded because its status is 26 h old, not because it is closed.",
  "evidence_event_ids": ["nws-wa-flood-20260802-0143"],
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
| `ping` | `{"t":"<iso8601>"}` keep-alive, roughly every 20 s |

### curl

```bash
curl -N -H 'Accept: text/event-stream' http://localhost:8787/v1/stream
```

```
event: ping
data: {"t":"2026-08-02T18:40:00Z"}

event: feed_update
data: {"event_id":"sdot-closure-12th-ave-20260802","event_type":"road_closure","headline":"12th Ave closed between E Pike St and E Madison St","severity":"moderate","status":"active","last_verified_at":"2026-08-02T18:18:00Z","source_count":1,"best_tier":"B","confidence_score":0.51,"confidence_label":"developing"}

event: ping
data: {"t":"2026-08-02T18:40:20Z"}
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

Every non-2xx response uses one shape:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Query parameters failed validation.",
    "details": [
      { "path": "lat", "message": "Number must be less than or equal to 90" },
      { "path": "radius_m", "message": "Expected number, received string" }
    ]
  }
}
```

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_request` | Zod rejected a query parameter or request body. `details` carries the field-level issues. |
| `404` | `not_found` | Unknown `event_id`, `resource_id`, or route. |
| `422` | `unroutable` | `/v1/routes` could not snap the origin or destination to the bounded demo graph. Not the same as "all candidates eliminated", which is a `200` with `recommendation: null`. |
| `500` | `internal_error` | Unexpected failure, including a response that failed its own output validation. `details` is omitted. |

`details` is present only for `invalid_request` and `unroutable`. The `message` field is
human-readable and may change; **branch on `code`, never on `message`**.

Two deliberate non-errors:

- **A source with an open circuit is not an error.** Requests still succeed against the
  records already in the store; the degradation is visible at `/v1/health`.
- **No matching records is not an error.** `/v1/events` and `/v1/resources` return `200`
  with an empty array. An empty result means "nothing verified in range", which is a fact,
  not a failure.
