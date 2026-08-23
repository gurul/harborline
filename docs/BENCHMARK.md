# Camp Fire benchmark — real-to-sim evaluation

Harborline's demo scenario is a wildfire evacuation near Chico, Butte County.
The deadliest documented event of exactly that shape happened there: the
**2018 Camp Fire** (Paradise, Nov 8 2018 — 84 direct deaths, ~18,800 structures,
~52,000 displaced). This document uses the documented record of that response —
the Butte County District Attorney's *Camp Fire Public Report* (June 2020),
NIST TN 2252 (notification/evacuation/traffic/temporary-refuge analysis), the
Butte County Grand Jury 2018–19 findings, and county public-health records — as
the ground-truth benchmark Harborline is evaluated against.

Two artifacts implement it:

- **`evals/src/real2sim-campfire.test.ts`** — an executable replay: the real
  timeline mapped onto the sim clock, with assertions at each checkpoint.
- **`evals/src/benchmark.test.ts`** — the Feather River rule in isolation.

## Real → sim mapping

| Real (2018) | Sim (Harborline demo) |
|---|---|
| Paradise ridge / advancing fire front | Seeded severe fire polygon, east Chico (`demo-fire-east-chico`) |
| Pentz Rd / Clark Rd / Skyway egress network | Demo road lattice; Oleander Ave + Mangrove Ave closures |
| Feather River Hospital (evacuating mid-procedure) | Fresh, "open" hospital placed inside the fire polygon |
| Neighborhood Church of Chico (a real Camp Fire shelter) | The same-named demo shelter |
| CodeRED reaching ~7,000 of 52,000 evacuees | Advice derived from observations, never gated on an order record |
| Oroville Nazarene at 352 occupants; Walmart-lot camp | The at-capacity demo shelter, rejected as `full` |
| Road status flipping through the morning | Freshness budgets: `road_closure` 4 h, shelter 24 h |

## Time-by-time replay

All real times PST, Nov 8 2018, from the DA report and NIST TN 2252. "Sim"
column states what Harborline outputs at the mapped moment; ✅ = asserted in
the replay eval, 🟡 = verified by probe/inspection, ⛔ = documented gap.

| Real time | Documented event | Harborline at the mapped moment | Status |
|---|---|---|---|
| 06:15 | PG&E logs the Caribou-Palermo fault; C-hook failure drops a conductor | Ingestion tier: an official report becomes a record only when a source publishes one — no fabrication ahead of evidence | 🟡 by design |
| 06:25 | First 911 to CAL FIRE ECC (**T0**) | Fire record active; surfaced for the user's radius with provider + age on every field | ✅ replay T0 |
| 07:23–07:46 | First order (Pulga) → first Paradise zone orders — **after** the fire reached town at 07:44; only ~7k of 52k ever alerted | With **no** `evacuation_order` record on file, the fire still surfaces and "should I stay?" still answers *leave* — advice from observations, not from order coverage | ✅ replay T0 · 🟡 probe: "Should I stay home?" → "Do not stay" |
| ~07:45 | Feather River Hospital evacuates ~67–80 patients, one mid-surgery; its own roster still reads "open" | A fresh, open facility inside the hazard polygon is rejected: `inside_hazard_zone`. Its "open" status does not save it | ✅ replay T0+80m |
| 08:00–14:15 | Every egress artery closed ≥1 time; ≥2 of 4 simultaneously closed 68% of the window; ~4 mph crawl; cars abandoned on Pearson Rd | Routes crossing a reported closure are **eliminated**, not down-ranked; survivors are risk-scored and phrased "lowest-risk route currently available", never "safe" | ✅ replay T0+2h35m |
| ~09:00+ | Road状态 changed faster than any channel tracked | `road_closure` records expire from the recommendation basis after 4 h; every answer carries the record's age and "conditions may change" | ✅ replay perishability |
| Mid-morning | Skyway contraflow delayed awaiting CHP; initiated manually by a local official | Out of scope: Harborline informs civilians; it does not command traffic operations. Surfaced as a limitation | ⛔ scope |
| Nov 8 evening | Shelters overflow; spontaneous Walmart-lot camp forms | At-capacity shelter rejected as `full` with capacity numbers shown; stale statuses rejected after 24 h with age shown | ✅ replay + acceptance scenario |
| Nov 14–17 | Norovirus at 4 shelters (140+ symptomatic); camp cleared while official shelters degraded | `health_advisory` on resources, surfaced with every recommendation and on the named plan-B option — an "open" status can no longer hide a public-health caveat | ✅ replay criteria 7+11 |
| Days–weeks | Chico absorbs ~20,000 people; regional housing saturates | Receiver-capacity balancing across cities is not modelled | ⛔ roadmap |

## Criteria scorecard

Derived from the documented failures; each row cites its real-event basis.

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Never route toward/through the hazard, even if shortest | **Met** (verified hazards) | Router eliminates `closure_intersection` / `evacuation_zone`; severity-scaled point standoffs. Projected-spread modelling: roadmap |
| 2 | Road/status data treated as perishable | **Met** | Freshness budgets per type; ages on every claim; stale ⇒ excluded from recommendations |
| 3 | State plainly when no safe route exists | **Met** | When every candidate is eliminated the answer says "no route is currently verified as passable" and gives refuge-in-place direction (cleared open ground — the NIST-documented TRA pattern); eval-pinned |
| 4 | Never gate advice on alert delivery | **Met** | Answers derive from records, not order coverage; "do not stay" issued with no order on file |
| 5 | Detect channel failure rather than assume delivery | **Met** (within scope) | Per-source health now includes `last_success_records` — a source that fetches fine but contributes zero records is visible at a glance, the "green-but-empty" mode that hid both connector bugs found in this audit. Outbound alert channels (WEA) belong to the alert originator |
| 6 | Flag when staged plans are outpaced by spread rate | **Met** (via CAP urgency) | An active severe/extreme hazard marked `immediate` appends "act on current conditions now rather than waiting for a zone-by-zone instruction" to every answer; eval-pinned. A quantitative spread-rate model stays roadmap |
| 7 | Shelter recommendations capacity- and health-aware | **Met** | Capacity: full ⇒ rejected, numbers shown. Health: `health_advisory` field on resources, surfaced with the recommendation ("Health advisory: …"), never hidden behind `open`; eval-pinned |
| 8 | Exclude facilities inside the hazard or themselves evacuating | **Met (new)** | `inside_hazard_zone` rejection added from this benchmark; fresh+open+in-zone ⇒ rejected |
| 9 | Proactive capacity actions (contraflow) | **Out of scope** | Civilian-information system, not traffic command |
| 10 | Prioritize mobility-limited users | **Met** (within scope) | Accessibility features surfaced per shelter, and when the question asks about accessibility a verified-accessible shelter outranks a marginally nearer one without recorded features (eval-pinned). Dispatching assisted evacuation is an emergency-operations function |
| 11 | Balance destinations against receiver capacity | **Partial** | The answer now names the explicit plan B ("If it is full when you arrive, next option: …") with its own capacity and freshness; multi-city load balancing needs region-scale occupancy data and stays roadmap |
| 12 | Provenance + timestamp on every advisory; contradictions reconciled explicitly | **Met** | Sources/tier/`last_verified_at` on every answer; `contradiction_note` keeps the official record standing while showing the dispute |

**Score: 10 met · 1 partial · 1 out-of-scope** (of 12). The benchmark has
produced code in three passes:

- **Pass 1 — the Feather River rule (criterion 8):** `inside_hazard_zone`
  rejection in `packages/agent-tools/src/tools.ts`.
- **Pass 2 — maximization:** refuge-in-place guidance when every route is cut
  (criterion 3), the `immediate`-urgency act-now note on both composer paths
  (criterion 6), the `health_advisory` field surfaced with every
  recommendation (criterion 7), and the named plan-B destination
  (criterion 11), all in `packages/agent-tools/src/composer.ts` +
  `packages/event-schema`, each pinned by
  `evals/src/real2sim-campfire.test.ts` and validated by `validateResponse`.
- **Pass 3 — convergence:** `last_success_records` on per-source health so a
  green-but-empty channel is detectable (criterion 5), and
  accessibility-aware shelter ranking when the question asks for it
  (criterion 10).

## What remains, and why

1. **Criterion 11 (receiver-city balancing) — partial pending data.** The
   answer names an explicit plan-B destination with capacity and freshness;
   region-scale balancing needs occupancy aggregation across towns, and the
   demo region has one receiver city.
2. **Criterion 9 (contraflow) — out of scope.** Traffic command, not civilian
   information.
3. **Criterion 6 quantitative extension:** a true spread-rate model (fire
   perimeter growth over successive records) would upgrade the CAP-urgency
   trigger to a measured one.

This is the convergence point for the current scope and data sources: every
remaining row requires either an operational role Harborline deliberately does
not hold, or data (multi-city occupancy, perimeter history) no current feed
provides.

## Sources

Primary: Butte County DA, *Camp Fire Public Report* (2020) · NIST TN 2252
(NETTRA) · NIST ESCAPE egress analysis · Butte County Grand Jury 2018–19 (via
KTVL/KQED coverage) · Butte County Public Health (norovirus counts via
SFGate/CBS) · Adventist Health / EMS World (Feather River evacuation) · PBS
Frontline (alerting failures) · CA Senate Governance review, "Evacuations
failed and 85 people died". Full URL list in the session research record;
key documents:

- <https://www.buttecounty.net/DocumentCenter/View/1881/Camp-Fire-Public-Report---Summary-of-the-Camp-Fire-Investigation-PDF>
- <https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.2252.pdf>
- <https://escape.nist.gov/evacuation3AddressingFailuresEgresslearnmore1>
- <https://www.pbs.org/wgbh/frontline/article/camp-fire-anniversary-new-details-troubled-evacuation/>
- <https://sgov.senate.ca.gov/system/files/2025-03/evacuations-failed-and-85-people-died-during-california.pdf>
