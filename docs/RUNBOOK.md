# Harborline — Runbook

Operating procedures: running the demo, reading source health, extending ingestion,
switching the assistant's composer, and the limitations you should know before you trust an
answer.

Ports throughout: **API `8787`**, **web `3000`**.

---

## Running the demo scenario

The acceptance flow from [BUILD_GUIDE.md §8](./BUILD_GUIDE.md) is the product thesis in one
sequence. It runs with no database, no Docker, and no API key.

### Start the stack

```bash
# from the repo root, once
npm install
npm run build

# terminal 1 — API on :8787, DEMO_MODE=1 is the dev default
npm run dev:api

# terminal 2 — web on :3000
npm run dev:web
```

Confirm the API is up and the demo connector has loaded before opening the UI:

```bash
curl -s http://localhost:8787/v1/health | jq '.status, (.sources[] | select(.id=="demo"))'
```

Expect `"ok"` and a `demo` source with `healthy: true` and a non-null `last_success_at`.
If there is no `demo` source in the list, `DEMO_MODE` was set to `0` in the environment —
unset it and restart.

Open **<http://localhost:3000>**.

### The five steps, and what to look for

**Step 1 — the map and feed load the seeded state.**

The map shows the east-Chico fire polygon (severe, red), two Chico Public Works road closures, and
three shelter markers with distinct open / full / stale treatments. The live feed pins the
**CAL FIRE evacuation warning** at the top with an amber accent: ranking is severity descending, then
freshness, and the tier A `severe` warning wins both.

Check the same thing from the API:

```bash
curl -s "http://localhost:8787/v1/events?lat=39.7398&lon=-121.8432&radius_m=3000" \
  | jq '.events[] | {event_id, severity, confidence_label, last_verified_at}'
```

The fire should carry `confidence_label: "official"`. The Oleander Ave closure should carry a
non-null `contradiction_note` and a **lower** label (`developing`) because a tier E social
report disputes it. That is correct behaviour, not a bug: the dispute reduces the
`consistency` factor, and the disagreement is displayed rather than averaged away. The
closure still stands and still eliminates routes.

**Step 2 — ask for the nearest open shelter.**

In the assistant panel use the suggested prompt **"Where is the nearest open shelter?"**, or:

```bash
curl -s -X POST http://localhost:8787/v1/assistant/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"Where is the nearest open shelter?","lat":39.7398,"lon":-121.8432}' | jq
```

Three shelters are considered and two are set aside:

| Shelter | Outcome | Why |
|---|---|---|
| Neighborhood Church | **recommended** | `open`, verified 8 min ago, tier B |
| Chico Community Center | rejected | `operational_status: "full"` |
| Bidwell Community Center | rejected | status 26 h old vs the 24 h shelter freshness policy → `rejected_reason: "stale_status"` |

The answer must name the exclusions and must not claim Bidwell is closed. "We cannot
verify" and "it is closed" are different statements, and only the first is supported by the
records.

**Step 3 — routing produces candidates, one eliminated.**

```bash
curl -s "http://localhost:8787/v1/routes?from_lat=39.7398&from_lon=-121.8432&to_resource_id=demo-shelter-neighborhood-church" \
  | jq '.candidates[] | {route_id, eliminated, rejected_reason, risk_score}'
```

The naively shortest candidate runs up Oleander Ave, intersects the active closure, and comes
back `eliminated: true` with `rejected_reason: "closure_intersection"`. It is **returned**,
not hidden — the rejection is evidence.

**Step 4 — the recommendation.**

```bash
curl -s "http://localhost:8787/v1/routes?from_lat=39.7398&from_lon=-121.8432&to_resource_id=demo-shelter-neighborhood-church" \
  | jq '.recommendation'
```

Assert four things: a non-null recommendation naming Neighborhood Church; a `summary` using
**"lowest-risk … currently available"** and never the word "safe"; `evidence_event_ids`
listing the hazards actually considered; and `"routing": "demonstration"`. In the UI the
bottom map bar reads *"Lowest-risk route to nearest open shelter — 8 min · avoids 2
hazards"* and the route draws as a teal line.

**Step 5 — the validator holds.**

The composed answer passes `validateResponse`. A doctored variant asserting "this route is
safe" fails on violation class 3. Both directions are asserted in the evals rather than by
hand:

```bash
npm test
```

The `evals/` suite covers all five violation classes, dedup and merge behaviour, freshness
boundaries, and this whole scenario end to end against a seeded `MemoryStore`.

### Resetting

The store is in-memory. Restart `npm run dev:api` and the demo state is re-seeded exactly
as before — the fixtures are deterministic, so ages are computed relative to boot time and
the scenario reproduces every run.

---

## Checking source health

`GET /v1/health` is the first thing to read when the map looks wrong.

```bash
curl -s http://localhost:8787/v1/health | jq '.sources[] | {id, healthy, circuit_open, consecutive_failures, last_success_at, last_error}'
```

| Symptom | Reading | Action |
|---|---|---|
| `healthy: true`, recent `last_success_at` | Source is fine | Look elsewhere — filters, radius, or the freshness policy |
| `healthy: false`, `consecutive_failures: 1–2` | Transient failure, backing off | Wait one or two refresh intervals |
| `circuit_open: true` | Breaker tripped after 3 consecutive failures | See below |
| `last_error` mentions a parse or validation failure | Upstream schema changed | The connector's Zod schema needs updating; the breaker is doing its job |
| `status: "degraded"` | Every source has an open circuit | The service is serving only what is already in the store |

### What "circuit open" means

After **3 consecutive failures** a source's breaker opens. Concretely:

- No further requests are sent to that upstream until the backoff window elapses
  (exponential, capped at 5 minutes), at which point one half-open probe is attempted. A
  successful probe closes the circuit and resets the counters; a failed probe re-opens it.
- The source reports `healthy: false` and `circuit_open: true`, with `last_error` carrying
  the most recent failure message.
- **Records that source already contributed remain in the store.** They are not deleted and
  not marked closed. They simply keep ageing, cross their freshness threshold, and drop out
  of recommendations on their own.

That last point is the important one. **Silence from a source is never read as "the hazard
cleared."** A dark NWS feed does not cancel a hazard warning; it just means the warning gets
older and eventually stops being described as current. If you want a hazard gone, an
upstream record must say so.

An open circuit is not an API error. Requests keep succeeding against stored data; the
degradation is visible only at `/v1/health`, which is why the UI reads it and surfaces a
banner.

---

## Adding a connector

A connector is any object implementing `Connector` from `@harborline/event-schema`. Nothing
else is required — no registration ceremony beyond exporting it.

**1. Create `connectors/src/<source>/index.ts`.**

```ts
import {
  type Connector,
  type ConnectorResult,
  REGION,
  bboxContains,
  computeConfidence,
  confidenceLabel,
  eventMaxAge,
} from "@harborline/event-schema";
import { z } from "zod";

// 1. Describe the UPSTREAM payload. Never trust its shape.
const UpstreamSchema = z.object({
  features: z.array(
    z.object({
      id: z.string(),
      properties: z.object({ headline: z.string(), sent: z.string() }),
      geometry: z.unknown(),
    }),
  ),
});

export const mySourceConnector: Connector = {
  id: "my-source",
  label: "My Source — human-readable name for /v1/health",
  source_tier: "B",
  expected_refresh_seconds: 300,

  async fetch(now): Promise<ConnectorResult> {
    const retrieved_at = now.toISOString();
    try {
      const res = await fetch("https://example.gov/feed.geojson", {
        headers: { "User-Agent": "Harborline (contact@example.org)" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return { ok: false, retrieved_at, error: `upstream responded ${res.status}` };
      }

      // 2. Validate at the boundary.
      const parsed = UpstreamSchema.safeParse(await res.json());
      if (!parsed.success) {
        return { ok: false, retrieved_at, error: `schema mismatch: ${parsed.error.message}` };
      }

      // 3. Map to CanonicalEvent / Resource + SourceRecord. Every item gets a
      //    source record with provider, tier, url, published_at, retrieved_at,
      //    content_hash — and an HONEST last_verified_at from the upstream
      //    timestamp, not from fetch time.
      return { ok: true, retrieved_at, events: [], resources: [], source_records: [] };
    } catch (err) {
      // 4. NEVER throw to the scheduler.
      return { ok: false, retrieved_at, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

**2. Export it** from `connectors/src/index.ts` and add it to the connector list the API
scheduler iterates in `services/api/src/scheduler.ts`.

**3. Add an eval** in `evals/` covering: a well-formed payload maps to the expected
canonical events; a malformed payload returns `ok: false` rather than throwing; and fetching
the same payload twice produces one event with one source record set, not a duplicate.

Five rules that are not optional:

1. **Never throw to the scheduler.** Every failure path returns `{ ok: false, error }`, or
   the source stops being observable at `/v1/health`.
2. **Zod-validate the upstream payload.** An upstream schema change must surface as a
   visible breaker trip, not as malformed events entering the store.
3. **`last_verified_at` comes from the data, not the clock.** If the upstream says a shelter
   status was recorded at 09:00, that is the verification time even if you fetched it at
   18:40. Stamping fetch time makes stale data look fresh — the exact failure the freshness
   policy exists to prevent.
4. **Set the tier honestly.** Tier is the authority of the *source*, not the plausibility of
   the claim. See the [tier table](./ARCHITECTURE.md#5-trust-tiers).
5. **Empty is not an error.** An upstream returning zero features is `ok: true` with empty
   arrays. Reserve `ok: false` for genuine failure, or the breaker will trip on quiet days.

Set `expected_refresh_seconds` no faster than the upstream's own publish cadence. Polling a
feed that updates daily every 60 seconds is 1,439 wasted requests and a good way to get
rate-limited.

---

## Enabling the optional LLM composer

By default the assistant is fully deterministic: `composeResponse` renders a template over
the tool evidence and `composed_by` reads `"deterministic"`. Setting a provider key
switches wording generation to the LLM composer — **and nothing else**. Two providers are
supported behind the identical prompt, validator, and fallback; Anthropic takes precedence
when both keys are set.

```bash
# Anthropic (llmCompose, Messages API)
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_MODEL=claude-sonnet-5     # optional; this is the default

# — or — OpenAI (llmComposeOpenAi, Responses API)
export OPENAI_API_KEY=sk-proj-...
export OPENAI_MODEL=gpt-5.6-luna           # optional; this is the default

npm run dev:api
```

> [!CAUTION]
> Keys are read from the environment only. Never commit them, never put them in
> `apps/web` (`NEXT_PUBLIC_*` variables are shipped to the browser), and never pass them
> through the API surface. The web app never sees them — only the Hono service calls
> the model provider.

What changes and what does not:

| | Key unset | Key set |
|---|---|---|
| Facts | tool evidence | tool evidence — **identical** |
| Wording | deterministic template | model-composed prose |
| `composed_by` | `"deterministic"` | `"llm"`, or `"deterministic"` if the answer was rejected |
| Safety validation | applied | applied, **unchanged** |
| Behaviour on rejection | n/a | falls back to `composeResponse` |
| Network calls per question | 0 | 1 |
| Latency | milliseconds | seconds |

The model receives the evidence JSON and a hard system prompt — *"You may only restate the
provided evidence"* — and its output goes through `validateResponse` exactly like any other
text. A rejected answer is discarded and the deterministic response is returned instead, so
a user never sees an unvalidated model claim.

Verify which path answered:

```bash
curl -s -X POST http://localhost:8787/v1/assistant/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"What changed in the last hour?","lat":39.7398,"lon":-121.8432}' \
  | jq '.composed_by'
```

If this returns `"deterministic"` with a key set, either the key is not reaching the process
or the model's answer was rejected. Check the API logs — rejections are logged with the
violation classes that fired. **Persistent rejection is a signal to investigate the prompt,
not to relax the validator.**

To turn it off, unset the provider key(s) and restart. Prose quality drops; coverage,
correctness, and every fact stay the same.

---

## Known limitations

Read these before trusting an answer in a real situation. None of them are bugs; all of
them are scope decisions documented in [PLAN_EVALUATION.md](./PLAN_EVALUATION.md) with
re-entry triggers in [ROADMAP.md](./ROADMAP.md).

**Shelter data is not real-time.** The FEMA/ARC open-shelter layer syncs **daily** and then
polls for updates. A shelter's true status can change hours before the feed reflects it.
Harborline handles this honestly rather than hiding it: `last_verified_at` comes from the
upstream attributes (never fetch time), the shelter freshness policy is 24 hours to match
the sync cadence, stale records are excluded from recommendations with
`rejected_reason: "stale_status"`, and the UI always shows the age. It cannot make the data
fresher than the source. **Call before travelling.**

**Routing is demonstration-grade.** The road graph is a hand-authored lattice of ~30–60
nodes around the Avenues in Chico, not the full street network. Outside
that footprint `/v1/routes` returns `422 unroutable`. Travel times are estimates from
segment length, with no traffic, signals, grade, or turn restrictions. Every recommendation
carries `"routing": "demonstration"` and phrases itself as "the lowest-risk route currently
available" — the pipeline is real (alternatives → spatial intersection → closure
elimination → risk scoring), the road network is not production data. A real routing engine
is gated on a data-quality SLA for closures; see the OSRM/Valhalla entry in
[ROADMAP.md](./ROADMAP.md).

**Storage is in-process and volatile.** `MemoryStore` holds everything in one Node process.
Restarting loses all state until connectors refill it, and running two API instances gives
you two divergent views. Single-instance only until `PostgisStore` lands.

**Confidence scores are uncalibrated.** The multiplicative formula is transparent and
reasoned, not fitted to outcome data. That is precisely why users see four ordinal labels
and never a percentage. Do not build downstream thresholds on the raw
`confidence_score`; use `confidence_label`.

**Coverage is one region at a time.** Connectors scope to the region bbox
(`REGION.bbox` — California statewide by default). Queries outside it return empty results — correctly, since
nothing has been verified there.

**No notifications, no offline mode, no community reports.** Harborline is pull-only: it
will not tell you when something changes unless the page is open. There is no offline cache
for low-bandwidth conditions, and there is no path for the public to submit reports. All
three are deferred deliberately — unreviewed community input is the fastest way to poison a
trust layer. See [ROADMAP.md](./ROADMAP.md).

**No linter.** The MVP configures `tsc --noEmit` (`npm run check`) and Vitest (`npm test`)
and nothing else. Biome is a roadmap item. Type errors are caught; style drift is not.
