# Harborline — Plan Evaluation

An engineering evaluation of the original 20-section build plan (see `docs/BUILD_GUIDE.md`
for the resulting implementation spec). Verdict up front: **the plan's core thesis is
correct and unusually disciplined for an AI product plan — but it is scoped for a
4–5 person team over 12 weeks. This repo implements a verifiable vertical slice of it,
preserving every architectural principle while cutting infrastructure and liability
surface that the MVP does not need.**

---

## What the plan gets right (kept as-is)

1. **Evidence-first architecture.** The central principle — *the database and rule
   engine determine facts; the language model explains them* — is the single most
   important decision in the plan. Every operational claim (shelter open, road closed)
   resolves to a structured record with provenance and freshness. The LLM never
   originates facts. This is kept as the load-bearing invariant of the codebase.

2. **Narrow first version.** One geography (one metro area at a time, via a single region config), two hazard classes
   (wildfire, severe weather — plus earthquakes since USGS is free and trivially
   integrable), three user needs, three interfaces. Kept exactly.

3. **CAP-grounded canonical schema.** Normalizing every source into one event model
   with `severity / urgency / certainty / status / geometry / freshness` mirrors the
   Common Alerting Protocol and is the right abstraction. Kept.

4. **Source tiers + labeled confidence.** Tier A–E authority hierarchy, a transparent
   multiplicative confidence score, and — critically — *labels, not fake percentages*
   shown to users (`Official / Verified / Developing / Unverified`). Kept.

5. **Contradiction display without false consensus.** Showing "DOT says closed; a newer
   community report claims movement, unconfirmed" instead of averaging. Kept as a
   product rule and a safety-validator rule.

6. **Deferring community reports.** Correct call. Unreviewed community input is the
   single fastest way to poison the trust layer. Deferred to roadmap.

7. **The §20 end-to-end demo flow.** "Hazard warning on the map → ask for nearest open
   shelter → one shelter rejected as stale → one route rejected for closure
   intersection → recommend lowest-risk route with sources, timestamps, uncertainty."
   This is the product thesis in one flow, and it is implemented here as the
   **acceptance scenario** (`evals/` + seeded demo mode).

---

## Where the plan over-reaches (corrected)

### 1. Team/timeline mismatch
Twelve weeks and five people is a funded-pilot plan, not an MVP plan. The plan's own
§20 admits the thesis is provable with one flow. **Correction:** build the vertical
slice first (this repo), then the 12-week roadmap becomes the scale-out path
(`docs/ROADMAP.md`).

### 2. Infrastructure overweight
Temporal/Celery, Kafka/Redpanda, Redis, Kubernetes, Terraform, OpenTelemetry, Grafana,
Sentry — for a pilot serving ~100 users this is operational drag, not resilience.
**Correction:** a storage interface with an in-memory geospatial implementation now,
a PostGIS adapter behind the same interface later. `infrastructure/docker-compose.yml`
ships PostGIS + Redis for the upgrade path but nothing requires it to run the demo.

### 3. Two-language stack
Python ingestion + TypeScript product doubles toolchains, CI, and hiring surface, and
the plan gives no compelling reason (the geospatial heavy lifting is in PostGIS, not
Python). **Correction:** all-TypeScript monorepo. Grounded versions (npm, 2026-08-02):
Next.js 16.2.12, Hono 4.12.33, Zod 4.4.3, MapLibre GL 6.1.0, Tailwind 4.3.3,
TanStack Query 5.101.4, TypeScript 7.0.2, Vitest 4.1.10.

### 4. Sentient coupling
ROMA is a beta recursive meta-agent framework; OpenDeepSearch is a web-retrieval tool.
Both are Python, latency-heavy, and — per the plan's own warnings — wrong for every
map pan and most questions. The plan already restricts them to "complex,
non-latency-sensitive investigations." **Correction:** the agent runtime is built
around an **adapter boundary** (`packages/agent-tools`): a deterministic tool pipeline
answers everything in the MVP; an optional LLM (any provider) only *composes language*
from tool output; a ROMA/OpenDeepSearch adapter slot is specified for the
"investigation" tier later. Sentient becomes a pluggable capability, not a dependency.

### 5. Routing liability
Real evacuation routing over live road networks is the highest-liability feature in
the plan. Shipping it in an MVP without a data-quality SLA on closures would be
irresponsible. **Correction:** the MVP implements the full *route-risk scoring
pipeline* (alternatives → segment/hazard spatial intersection → closure elimination →
risk scoring → honest language) over a real but bounded demonstration road graph (the Avenues in Chico, CA), clearly
labeled as demonstration routing. The OSRM/Valhalla adapter is specified but not wired
to production claims.

### 6. Shelter freshness is not real-time
FEMA's shelter layer syncs daily then polls for updates — the plan notes this but the
UI mocks show minute-fresh shelter status. **Correction:** freshness is a first-class
field everywhere; the resource service *rejects* stale-status shelters from
recommendations (the §20 flow), and the UI always shows `last_verified_at` age.

### 7. Confidence calibration
The multiplicative formula is transparent but uncalibrated; the plan correctly says
never to show precise percentages. **Correction:** the score exists internally for
ranking; users only ever see the four ordinal labels tied to tier + freshness +
corroboration rules.

---

## Risk register (top 5)

| Risk | Likelihood | Mitigation in this repo |
|---|---|---|
| LLM asserts unverified operational fact | High without controls | Safety validator rejects responses containing uncited operational claims; deterministic composer fallback |
| Upstream schema change (NWS/FEMA) breaks ingestion | Medium | Connector-level Zod validation, circuit breaker, source-health endpoint, raw payload retention |
| Stale data presented as current | High | Freshness policy per source type; hard display of age; stale records excluded from recommendations |
| Demo depends on live disaster occurring | Certain | Deterministic seeded scenario (California wildfire) alongside live connectors |
| Sentient framework churn (beta) | Medium | Adapter boundary; zero hard dependency in MVP |

---

## Bottom line

The original plan is a good production plan executed at the wrong altitude for a
first build. This repo flies the same heading at MVP altitude: **same schema, same
trust model, same safety rules, same demo thesis — one language, one process, zero
mandatory infrastructure.** Everything cut is documented in `docs/ROADMAP.md` with
its trigger condition for re-entry.
