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
| Nov 14–17 | Norovirus at 4 shelters (140+ symptomatic); camp cleared while official shelters degraded | Health-status of shelters is not modelled beyond open/full/closed — a `health_advisory` flag on resources is a gap | ⛔ roadmap |
| Days–weeks | Chico absorbs ~20,000 people; regional housing saturates | Receiver-capacity balancing across cities is not modelled | ⛔ roadmap |

## Criteria scorecard

Derived from the documented failures; each row cites its real-event basis.

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Never route toward/through the hazard, even if shortest | **Met** (verified hazards) | Router eliminates `closure_intersection` / `evacuation_zone`; severity-scaled point standoffs. Projected-spread modelling: roadmap |
| 2 | Road/status data treated as perishable | **Met** | Freshness budgets per type; ages on every claim; stale ⇒ excluded from recommendations |
| 3 | State plainly when no safe route exists | **Partial** | Null recommendation + explicit reason ("every candidate eliminated"); temporary-refuge-area fallback guidance is roadmap |
| 4 | Never gate advice on alert delivery | **Met** | Answers derive from records, not order coverage; "do not stay" issued with no order on file |
| 5 | Detect channel failure rather than assume delivery | **Partial** | Per-source ingest health with circuit breakers is monitored and surfaced (`/v1/health`); outbound alert channels (WEA) are out of Harborline's scope |
| 6 | Flag when staged plans are outpaced by spread rate | **Gap** | No spread-rate model; roadmap |
| 7 | Shelter recommendations capacity- and health-aware | **Partial** | Capacity: met (full ⇒ rejected, numbers shown). Health advisories (norovirus): gap |
| 8 | Exclude facilities inside the hazard or themselves evacuating | **Met (new)** | `inside_hazard_zone` rejection added from this benchmark; fresh+open+in-zone ⇒ rejected |
| 9 | Proactive capacity actions (contraflow) | **Out of scope** | Civilian-information system, not traffic command |
| 10 | Prioritize mobility-limited users | **Partial** | Accessibility features surfaced per shelter; assisted-evacuation dispatch out of scope |
| 11 | Balance destinations against receiver capacity | **Gap** | Nearest-verified-open with capacity shown; multi-city load balancing roadmap |
| 12 | Provenance + timestamp on every advisory; contradictions reconciled explicitly | **Met** | Sources/tier/`last_verified_at` on every answer; `contradiction_note` keeps the official record standing while showing the dispute |

**Score: 5 met · 4 partial · 3 gap/out-of-scope** (of 12). The benchmark's
direct product in this pass is criterion 8 — the **Feather River rule** —
implemented as the `inside_hazard_zone` rejection in
`packages/agent-tools/src/tools.ts` and pinned by the two eval suites above.

## Where the gaps go next

1. **Refuge-in-place guidance (criterion 3):** when every route is eliminated,
   direct to the nearest defensible open area — NIST documents 31 temporary
   refuge areas holding 1,200+ civilians. Needs a refuge-area resource type.
2. **Health advisories on shelters (criterion 7):** a `health_advisory` field
   on `Resource`, tier-B sourced from county public health.
3. **Spread-rate awareness (criterion 6):** the fire covered 7 miles in ~90
   minutes; a growth-rate annotation on fire events would let the composer say
   "spreading faster than staged evacuation assumes".
4. **Receiver capacity (criterion 11):** aggregate shelter capacity by town and
   bias recommendations away from saturated destinations.

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
