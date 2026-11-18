# Harborline (Best Use of the Agent @ Sentient Labs Hackathon)

<p align="center">
  <img src="assets/concept.png" alt="Harborline — the calmest point in every crisis. A community-first disaster clarity system powered by Sentient GRID, delivering fast, localized situation summaries and safe movement guidance" width="100%">
</p>

Harborline puts official alerts, open shelters, road risk, and an evidence-backed assistant in one view, built for a person who is stressed and needs a straight answer. The system is location-agnostic — all geography lives in one region config — and ships configured for California, where wildfire is a fact of life.

Disaster information is scattered across agency feeds, news, and social posts, and the tools that aggregate it tend to hallucinate at exactly the moment accuracy matters. Harborline flips the usual AI architecture. It ingests official emergency feeds into one canonical geospatial event model, with provenance and freshness on every record, and the language model can only restate what those records say. The database decides what is true; the model puts it into words. If Harborline says a shelter is open, that is because the county's emergency management agency verified it 8 minutes ago, not because a model guessed.

Built for the **Sentient Labs Hackathon (50 Selected Builders)**, where it won **Best Use of the Agent**.

<p align="center">
  <img src="assets/best-use-of-the-agent.png" alt="The Harborline team accepting the Best Use of the Agent award at the Sentient Labs hackathon" width="100%">
</p>

<p align="center">
  <i>Best Use of the Agent: Jacob Frans, Kshitij Rao, Gurucharan Lingamallu, Hemkesh Bandi</i>
</p>

## What Harborline does

1. **Ingest official sources.** Connectors poll NWS alerts, USGS earthquakes, FEMA National Shelter System shelters, NIFC WFIGS wildfire perimeters and incidents, NASA FIRMS VIIRS satellite heat detections (NOAA-20 and NOAA-21), AirNow air quality, NOAA NWPS river gauges and NOAA HMS smoke analyses. No feed needs a key. Each runs on its own schedule with backoff, circuit breakers, and per-source health you can inspect at `/v1/health`. When a successful, non-empty poll no longer returns a record the same source returned before, that shelter is marked closed and that alert expired; an empty or failed poll changes nothing.
2. **Normalize everything into one event model.** Every record becomes a `CanonicalEvent` with CAP-style severity/urgency/certainty, GeoJSON geometry, and a `SourceRecord` trail. Repeat reports of the same event merge by id with the provenance trail intact; cross-provider dedup is built and eval-tested but not yet wired into ingest (see [docs/ROADMAP.md](./docs/ROADMAP.md)).
3. **Score trust transparently.** Sources are tiered from A (issuing authority) down to E (unverified report). Internally, confidence is `authority × freshness × corroboration × precision × consistency`. Users only ever see one of four labels: `official / verified / developing / unverified`. There are no invented percentages.
4. **Enforce freshness.** Every event and resource type has a maximum acceptable age. A shelter whose status is 26 hours old still appears, along with its age, but recommendations reject it with an explicit `stale_status` reason. Hazard records fail closed: a stale closure or fire is flagged with its age but still blocks routes and still excludes a shelter inside it.
5. **Treat satellite detections as unconfirmed.** A FIRMS heat detection is not a fire report: it can be a false positive (a gas flare, hot ground) and it misses fires under cloud. Detections are clustered into footprint polygons and never eliminate a route. A route through one costs a fixed penalty (15 min for a moderate cluster, 30 min for a severe one seen on two passes), triggers a second search that avoids it, and is named in the route summary and the recommended action. Only a two-pass severe cluster rejects a shelter. A WFIGS perimeter under 50 percent contained is an official severe fire area and eliminates a crossing route.
6. **Route around verified hazards.** Candidate routes are intersected with hazard geometry. Routes that cross a closure, an evacuation zone, or a fire, flood or landslide area of severity severe or higher are eliminated; if every alternative is cut, the search reruns with those roads removed before giving up. A user who starts inside an evacuation zone is routed out of it. The survivors are risk-scored, a kept route that still passes a lower-severity hazard says so, and the answer is phrased as "the lowest-risk route currently available" rather than "safe".
7. **Answer questions from evidence only.** The assistant plans which tools to run, gathers structured evidence, and composes an answer from deterministic templates, or from an optional LLM for wording. The recommended action always comes from the deterministic composer, and the LLM is not called when no route is verified. A safety validator checks for unsupported operational wording, stale-as-current language, guarantees, and missing sources; rejected answers fall back to the deterministic composer. These heuristic checks do not prove that every LLM claim matches the record (see [review findings](./docs/CRITICAL_REVIEW.md)). Fire and air questions get their own templates. The answer never says there is no fire or that the air is safe, a model-stated AQI must match the reading, and a stale reading is never stated as current. A shelter request can carry `access_needs` and a chosen `destination_resource_id`, and the response carries the route to the shelter it names.
8. **Show contradictions honestly.** When a social post disputes an official closure, the closure stays closed and gains a `contradiction_note`. Harborline does not average sources into a false consensus.
9. **Summarise the environment at a point.** `GET /v1/environment` returns the nearest air-quality reading, the nearest river gauge with its NWS flood category, nearby fire records, and power, each with provider, tier and age. No power-outage source is configured, so power is reported as not monitored, never as "no outage".

## Why it is different

Most disaster chatbots put the model in front: they search, summarize, and hope the summary is right. Harborline puts a verified geospatial event layer in front and treats the model as a constrained interface to it, to constrain model output. Its heuristic validator catches specific failure patterns, but does not establish complete semantic grounding of optional LLM wording. The whole demo runs deterministically offline (`DEMO_MODE=1` seeds a California wildfire scenario over Chico, with every demo provider name prefixed `DEMO ·`), and 222 automated eval tests enforce the acceptance scenario and the hardening invariants: the stale shelter is rejected, the closed road is eliminated, and the lowest-risk route is recommended with sources and timestamps.

The [critical code review](./docs/CRITICAL_REVIEW.md) added regressions for consistent shelter selection and routing, hazard checks on route approaches, unavailable destinations, and travel advice when no route is verified. A second review (2026-11-15) found routes through severe fire areas, stale hazards ignored in shelter checks, and a hand-typed benchmark score; its fixes and regressions are listed in the same document. `.era/runtime` is local runtime state and is not included in the repository.

## Research grounding

The design and its hardening pass are grounded in a citation-verified corpus of 30 sources — OASIS/FEMA alerting standards, the NIST Camp Fire case study, the warning-message and crisis-informatics literature, and recent arXiv work on LLM safety in disaster response. Every cited source was live-fetched and checked before being relied on. [docs/RESEARCH.md](./docs/RESEARCH.md) records the twelve best-evidenced protocols, where Harborline matches them, which findings became code (the five-element warning completeness rule, the reassurance-language ban, severity-scaled hazard standoffs, read-time confidence decay), and which remain roadmap items.

## Evaluation: benchmarked against the real Camp Fire

Harborline's demo is a wildfire evacuation near Chico, Butte County. The deadliest documented event of exactly that shape happened there — the **2018 Camp Fire** (84 deaths, ~52,000 displaced, every egress artery out of Paradise closed by fire at least once). So the evaluation standard is not a synthetic rubric: it is the documented record of how that response actually unfolded, drawn from the Butte County DA's investigation, NIST TN 2252's evacuation-and-traffic analysis, and the county Grand Jury findings.

[docs/BENCHMARK.md](./docs/BENCHMARK.md) maps the real timeline onto the simulation **hour by hour** — first 911 call (06:25), fire reaching town before most evacuation orders (07:44 vs 07:46–09:03), Feather River Hospital evacuating patients mid-surgery while its roster still read "open", every egress artery closing, shelters overflowing into the Walmart parking lot — and derives **12 testable criteria** from those documented failures. An executable replay (`evals/src/real2sim-campfire.test.ts`) asserts Harborline's behavior at each mapped moment.

Current scorecard: **9 of 12 criteria met**, 2 partial, 1 out of scope. The count is computed from the replay's named tests by `npm run scorecard`, and CI fails if this line or the benchmark page disagrees with it. Criterion 1 (never route through the hazard) is partial: severe fire, flood and landslide areas eliminate a route, but a kept route may still pass a lower-severity hazard area, which the answer discloses. The benchmark produces code, not just grades. Its first product is the **Feather River rule** — a fresh, nominally "open" facility located inside an active severe hazard footprint is rejected outright (`rejected_reason: "inside_hazard_zone"`), because the most dangerous record in a disaster is the one that is accurate about status and silent about geography. A maximization pass then closed three more criteria: **refuge-in-place guidance** when every route is eliminated (the NIST temporary-refuge-area pattern), an **act-now note** when a severe hazard is marked `immediate` (the fire beat Paradise's first zone order by two minutes), and **shelter health advisories plus a named plan-B destination** (norovirus ran through four "open" shelters while overflow arrivals improvised in a parking lot). A convergence pass closed two more: **green-but-empty detection** on every ingest source (per-source `last_success_records` in `/v1/health` — the silent-channel failure class of the county's undetected WEA outage) and **accessibility-aware ranking** when the question asks for it. What remains: lower-severity hazard crossings (criterion 1), receiver-city load balancing, which needs multi-town occupancy data, and contraflow, which is traffic command — argued row by row in the benchmark.

## Sentient technology

Harborline was designed around Sentient's open-source GRID ecosystem, and one leg of that design is now implemented: **Harborline serves as a Sentient Chat agent** through the official Sentient Agent Framework. `services/sentient-agent` is a thin Python adapter (`sentient-agent-framework` 0.3.0) that exposes the framework's SSE `POST /assist` protocol and re-emits Harborline's already-validated answers as Sentient Chat events — `EVIDENCE` (sources with tiers and ages), a streamed `ANSWER`, `ACTION`, and `CAVEATS`. No decision logic lives in the adapter; it is pure presentation over the evidence-gated pipeline. `packages/agent-tools` still defines the adapter slot where ROMA (recursive meta-agent investigations of conflicting reports) and OpenDeepSearch (open-web retrieval beyond the structured feeds) plug in behind the same tool contract — agent orchestration sits above the evidence layer; it does not replace it. [docs/SENTIENT.md](./docs/SENTIENT.md) covers the full design and current status of each integration.

## Architecture

```mermaid
flowchart LR
    A[NWS · USGS · FEMA · WFIGS · FIRMS<br/>AirNow · NWPS · HMS · demo] --> B[Ingestion scheduler<br/>backoff + circuit breaker]
    B --> C[Normalization<br/>merge by event id, all source records kept]
    C --> D[Verification<br/>tier x freshness x corroboration → label]
    D --> E[(EventStore<br/>MemoryStore now, PostGIS later)]
    E --> F[Deterministic services<br/>stale rejection · route-risk]
    E --> G[Agent tools<br/>plan → gather → compose → validate]
    F --> H[Hono API :8787<br/>REST + SSE]
    G --> H
    H --> I[Next.js :3000<br/>map · live feed · assistant]
```

[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) has the full detail: trust tiers, the confidence formula, freshness tables, the route-risk pipeline, and the validator's rejection rules.

## Using the web app

The web app at `apps/web` has four views. On a desktop the map stays on the right and a rail on the left switches between the other three. On a phone a bottom bar switches between all four.

- **Now** shows the most urgent alert, the nearest open shelter with a **Route here** button, and tiles for alerts, fire, air quality, river level and power. Each value shows its source and age. A tile that has no data says so; it never shows a calm reading in place of missing data.
- **Map** shows streets, hazard areas, shelters, closures, the route and unconfirmed satellite heat footprints. The **Layers** menu switches to imagery (not live) and turns layers on and off. From zoom 9 the imagery is USGS aerial photos (about 1 m per pixel, United States only, months to years old). Below zoom 9 it is the NASA GIBS daily satellite image for a chosen day (250 m per pixel), which shows smoke and cloud.
- **Alerts** lists active alerts with filters (All, Official, Within 3 km, Weather) and opens each one with its instructions and sources.
- **Ask** sends a question to the assistant. When the answer names a shelter, **Route to** draws the route that came with the answer.

**Settings** holds your location (device, a point you pick on the map, or the demo default), your access needs and a larger-text option. The browser saves these in `localStorage` on your device. Your location is sent with each data request. The access needs the API understands (wheelchair access, accessible restroom, pets) are sent with each question to the assistant.

## Quick start

Requires Node 20 or newer. You don't need a database, Docker, or any API keys: every feed is keyless.

```bash
npm install
npm run build      # schema → agent-tools → connectors → api → web
npm run dev:api    # terminal 1 — API on :8787; the dev script sets DEMO_MODE=1
npm run dev:web    # terminal 2 — web on :3000
```

Open **<http://localhost:3000>**. The seeded scenario gives you an active wildfire evacuation warning over east Chico, two road closures, three shelters (one stale, one full), and a contradicting social report. Ask the assistant *"Where is the nearest open shelter?"* and watch it reject the stale one.

## Safety principles

1. Structured records determine facts; the language layer only restates them.
2. Every displayed fact carries its provider, trust tier, and `last_verified_at` timestamp.
3. Freshness is enforced. Stale records appear with their age, but they are not recommended or described as current.
4. The deterministic composer uses structured records; missing data comes back as "unknown / not verified". Optional LLM wording still has a known semantic-validation gap described in [review findings](./docs/CRITICAL_REVIEW.md).
5. The confidence score stays internal; users see one of four calibration-honest labels instead of a percentage.
6. Contradicting sources are shown side by side instead of being averaged.
7. The system avoids guarantee language: routes carry `"routing": "demonstration"` and hedged wording by construction.
8. The validator is the last gate. LLM output that breaks any of these rules is discarded in favor of the deterministic composer.

## Configuration

| Variable | Scope | Default | Purpose |
|---|---|---|---|
| `PORT` | `services/api` | `8787` | API port |
| `DEMO_MODE` | `services/api` | off (`npm run dev:api` sets `1`) | `1` seeds the deterministic California wildfire scenario at boot, with provider names prefixed `DEMO ·`; live connectors keep running. Unset or any other value: live feeds only, so `npm start` serves no demo data unless you set it |
| `ANTHROPIC_API_KEY` | `services/api` | unset | Optional. Enables the LLM composer for wording; output still passes the safety validator or is discarded |
| `ANTHROPIC_MODEL` | `services/api` | `claude-sonnet-5` | Composer model override; only read when the key is set |
| `OPENAI_API_KEY` | `services/api` | unset | Optional. Same wording-composer role via the OpenAI Responses API; used when `ANTHROPIC_API_KEY` is not set. Same validator gate and deterministic fallback |
| `OPENAI_MODEL` | `services/api` | `gpt-5.6-luna` | OpenAI composer model override; only read when that key is in use |
| `ALLOWED_ORIGINS` | `services/api` | unset | Comma-separated CORS allowlist. Unset: localhost-only in dev, deny cross-origin in production |
| `TRUST_PROXY` | `services/api` | unset | Set `1` only behind a TLS-terminating proxy that appends to `X-Forwarded-For`: rate limiting then keys on the last entry (the one the proxy added) instead of the socket address |
| `NEXT_PUBLIC_API_URL` | `apps/web` | `http://localhost:8787` | REST + SSE base URL |

The fire, air, gauge and smoke feeds need no variable. Their rate limits and terms of use are not confirmed (the FIRMS area files, NWPS and the ArcGIS layers), so they poll slowly: every 15 minutes for gauges and every 30 minutes for the rest. Outbound requests send the generic User-Agent `harborline-feed/1.0`.

Geography is not scattered through the code: everything location-specific — map centre, connector bounding box, NWS alert area, shelter state filter — lives in a single `RegionConfig` at `packages/event-schema/src/region.ts`. The default region is California, centred on Chico (Butte County). To point Harborline at a different area, change that one file; the seeded demo scenario and the demonstration road graph share the Chico geography and would be re-authored alongside it.

## Commands

| Command | Description |
|---|---|
| `npm run dev:api` | Run the API with the seeded demo scenario on `:8787` |
| `npm run dev:web` | Run the web app on `:3000` |
| `npm run build` | Build every workspace in dependency order |
| `npm run check` | Builds the libraries, then `tsc --noEmit` across all workspaces. Works from a clean clone |
| `npm test` | Builds the libraries, then 222 Vitest evals (plus 1 skipped: the out-of-scope benchmark criterion): safety validator, dedup, freshness, hardening invariants, acceptance scenario, review regressions, Camp Fire real-to-sim benchmark, satellite-fire safety rules, feed normalization from recorded responses, environment route |
| `npm run -s smoke:live` | Calls each fire, air, gauge and smoke connector once against the live service. Prints one line per connector, then `LIVE_SMOKE_OK` only when all return ok (exit 1 otherwise). Makes real network calls, so CI does not run it. Needs `npm run build:libs` first |
| `npm run scorecard` | Computes the Camp Fire scorecard from the replay tests; `-- --verify-docs` also checks this README and docs/BENCHMARK.md state the same count. Needs `npm run build` first |

CI (`.github/workflows/ci.yml`) runs `npm ci`, build, check, test and the scorecard check on every push and pull request.

## Project layout

| Path | What |
|---|---|
| `packages/event-schema` | The canonical contract: `CanonicalEvent`, `SourceRecord`, `Resource`, `Observation` (air, gauge and smoke readings), routing types, confidence + freshness policy, `Connector` interface |
| `packages/agent-tools` | `EventStore`/`MemoryStore`, tool registry, query planner, composer, optional LLM wrapper, safety validator, route-risk engine |
| `connectors` | NWS, USGS, FEMA shelters, NIFC WFIGS, NASA FIRMS, AirNow, NOAA NWPS, NOAA HMS smoke, and the seeded demo scenario |
| `services/api` | Hono REST + SSE + ingestion scheduler |
| `services/sentient-agent` | Python adapter serving Harborline as a Sentient Chat agent (Sentient Agent Framework, SSE `POST /assist`) |
| `apps/web` | Next.js 16 UI: MapLibre dark map, live feed, assistant |
| `evals` | Vitest suites for safety, dedup, freshness, the satellite-fire safety rules, and the end-to-end scenario. `evals/src/fixtures/` holds one recorded live response per new feed |
| `scripts` | Scorecard computation and the live connector smoke check |
| `infrastructure` | Optional PostGIS + Redis compose stack for the upgrade path |
| `docs` | [Build guide](./docs/BUILD_GUIDE.md) · [plan evaluation](./docs/PLAN_EVALUATION.md) · [architecture](./docs/ARCHITECTURE.md) · [API reference](./docs/API.md) · [runbook](./docs/RUNBOOK.md) · [roadmap](./docs/ROADMAP.md) · [research grounding](./docs/RESEARCH.md) · [Camp Fire benchmark](./docs/BENCHMARK.md) · [Sentient integration](./docs/SENTIENT.md) |

## Built with

TypeScript end to end: Next.js 16, React 19, Tailwind 4, MapLibre GL, TanStack Query, Hono, Zod 4, Vitest. Basemap © OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors; daily satellite imagery from NASA GIBS; aerial photos from USGS The National Map and USDA. Alert data © NOAA/NWS, USGS, and FEMA/American Red Cross; fire data from NASA FIRMS and NIFC; air quality from AirNow (EPA and partner agencies); river and smoke data from NOAA. Each is retained with its source record. Designed around Sentient's open-source GRID ecosystem (ROMA, OpenDeepSearch) via the adapter boundary in `packages/agent-tools`.

## License

MIT. See [LICENSE](LICENSE).

---

> **Note on the revamp.** This repository is a ground-up rebuild of the original
> Sentient Labs hackathon project. The hackathon version proved the concept and won
> the award. The rebuild brings it up to current engineering and research practice:
> an evidence-first architecture with provenance and freshness on every record, a
> safety validator gating all model output, 222 automated evals including the full
> acceptance scenario, a research-driven security and correctness hardening pass
> (rate limiting, bounded SSE, store lifecycle, prompt-injection defenses,
> read-time confidence decay, the five-element warning rule — see
> [docs/RESEARCH.md](./docs/RESEARCH.md)), and documentation grounded in the
> current upstream Sentient stack ([docs/SENTIENT.md](./docs/SENTIENT.md))
> rather than hackathon-week memory.
