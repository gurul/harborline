# Critical LLM review — 2026-09-17

This was a focused correctness review with an independent read-only LLM judge, followed by implementation, adversarial re-review, and executable verification. It was not an exhaustive audit or a production-readiness certification.

## Confirmed defects fixed

| Failure before the patch | Changed behavior | Evidence |
|---|---|---|
| Accessibility preference selected shelter B only during composition, after routing to nearer shelter A. | Shared resource ranking runs before route generation. The API uses the same evidence assembler as evaluations. Hand-built bundles cannot transfer another destination's route into the answer. | Tool and real API-handler regressions assert the selected resource, route destination, endpoint, and action agree. |
| Departure and arrival approach legs appeared in route geometry but were omitted from hazard scoring. | Both approaches are scored, including exact endpoints and zero-length approaches; graph-junction margins remain unchanged. | Synthetic graph cases put closures on each approach and on each actual endpoint; a no-closure control remains routable. |
| Direct routing accepted closed, full, unknown, stale, or hazard-contained destinations. | The route tool uses the same resource-status and hazard-containment helpers as nearby selection. The API returns `422 destination_unavailable` with a reason. | Parameterized resource cases, a fresh/open positive control, and an API error-contract regression. |
| No surviving route still produced “Head for…” advice, while a graph coverage failure could produce refuge guidance. | Departure advice requires a route recommendation. Unsupported/absent routing states uncertainty; closure/evacuation elimination retains the existing blocked-route explanation. | Blocked, `no_path`, and missing-route cases. |

Evidence assembly is now shared across the assistant API and tool callers. The recent-update window, event freshness metadata, and provider attribution are retained. Prompt capping happens inside the LLM adapters so response provenance uses the full evidence bundle.

The first regression run reproduced **11 failures with 2 passing controls** before implementation. The judge's second pass identified endpoint blind spots and lost event freshness metadata; both were corrected with additional regressions. The final read-only judge found no remaining blockers in these four fixes. `evals/src/review-regressions.test.ts` adds **19 cases**, and the complete suite passes **108 tests**. Workspace typechecking and the production build passed. The local acceptance ledger records 5 met gates, 0 unmet, and 0 abandoned, including runtime removal with a positive-control check.

## Remaining limitation

The optional LLM validator does not establish per-entity semantic agreement. A freshly closed shelter supplies enough resource evidence for an LLM statement that it is open to pass the operational-word check. This fifth finding is **not fixed** by the routing patch. The next step is a constrained operational-claim contract with deterministic rendering, rather than claiming a few more regular expressions can prove arbitrary prose. See [ROADMAP.md](./ROADMAP.md#known-correctness-gap-llm-claim-grounding).

The existing demonstration graph, approximate geometry sampling, accessibility-feature heuristic, and lack of live road-network coverage remain. Tests exercise synthetic and seeded scenarios, not real-world evacuation outcomes.

## Runtime cleanup

Removed `.era/runtime`, including the previously tracked plan and local runtime events, as requested. Its ignore rule remains so runtime output is not accidentally added again.

---

# Judge review — 2026-11-15

A second critical review ran against `895345e`. It found 15 defects; each was checked against the code before any change. Every behavioural finding is pinned by a test named with its number in `evals/src/judge-regressions.test.ts` (22 tests). Copied into a clean build of `895345e`, that file fails 21 of its 22 tests on assertions, not at import. The one that passes there is a control: a user outside an evacuation zone still has routes into it eliminated.

## Findings and status

| # | Severity | Finding | Status | Change |
|---|---|---|---|---|
| 1 | CRITICAL | A route through an active severe fire was recommended, and the summary said it "avoids 0 reported hazards" | Fixed | Fire, flood and landslide areas of severity severe or higher eliminate a route (`rejected_reason: "hazard_zone"`). A kept route that crosses any hazard says "passes through or near N reported hazard areas", in the summary and the recommended action. The composer gives refuge advice when every candidate is cut by `hazard_zone` |
| 2 | CRITICAL | A hazard past its freshness limit was ignored in shelter checks, so a shelter inside the fire became "the nearest open shelter" | Fixed | Containment fails closed: stale hazard records still exclude. Evacuation orders exclude at any severity |
| 3 | HIGH | A user inside an evacuation zone never got a route out | Fixed | A zone (evacuation order or hazard area) that contains the origin does not eliminate routes. Routes into a zone from outside it are still eliminated |
| 4 | HIGH | "No route" when an open route existed: (a) the 4 penalised alternatives all shared closed edges; (b) a closure ending at the destination intersection blocked the destination | Fixed | (a) When no alternative survives, the search reruns on the graph with every eliminating edge removed. (b) Zero-length approaches are not checked against line closures that only end at that intersection |
| 5 | HIGH | Shelters that left FEMA's open-shelter feed stayed "open" for 24 h | Fixed | After a successful, non-empty fetch, the scheduler closes shelters and expires events that the same connector returned before and no longer returns. An empty or failed fetch changes nothing |
| 6 | HIGH | NWS evacuation and fire alerts were typed `weather_warning` | Fixed | "Evacuation …" maps to `evacuation_order`, "Fire Warning" to `fire`. Shelter-in-place and civil-danger warnings stay `weather_warning`: there is no closer canonical type |
| 7 | HIGH | DEMO_MODE was on when unset, and the seeded fire was attributed to CAL FIRE | Fixed | DEMO_MODE is on only when it is `1`; the `dev` script sets it. Every demo provider name starts `DEMO · ` |
| 8 | HIGH | The LLM path could give departure advice when every route was eliminated; an empty `ANTHROPIC_API_KEY` disabled a valid OpenAI key | Fixed | The model is not called when a route was computed and none survived. On the LLM path the recommended action is always the deterministic composer's. Key selection uses `\|\|` |
| 9 | HIGH | The Camp Fire replay reseeded at every checkpoint, the scorecard was typed by hand, and criterion 1 was marked met but failed | Fixed | The replay seeds once at T0 and queries at T0+80 min, +2 h 35 min and +5 h. Each criterion has tests named `criterion N <verdict>: …`. `npm run scorecard` computes the count; `--verify-docs` fails CI when the README or the benchmark page disagree. Honest score: 9 of 12 met. Criterion 1 is now **partial**, not met: lower-severity hazard crossings are kept and disclosed |
| 10 | MEDIUM | `npm ci && npm run check` and `npm test` failed on a clean clone; no CI | Fixed | `precheck` and `pretest` build the libraries. `.github/workflows/ci.yml` runs install, build, check, test and the scorecard check on Node 22 |
| 11 | MEDIUM | FEMA attribute coordinates were rounded to whole degrees | Fixed | Coordinates use an unrounded reader |
| 12 | MEDIUM | With `TRUST_PROXY=1` the client chose its rate-limit key (leftmost `X-Forwarded-For`) | Fixed | The key is the last hop, the one the trusted proxy appended |
| 13 | MEDIUM | The Sentient agent answered every user for Chico without saying so, and reported 429 and 400 as "unreachable" | Partly fixed | Each answer now states the assumed location (`LOCATION` block and `CAVEATS.location_note`); 429 maps to "busy, ask again" and 400 to "question not accepted". Not done: per-user location from the chat surface, and a separate rate-limit key for the agent. Not run against a live framework server |
| 14 | MEDIUM | False documentation lines | Fixed | README ingest diagram, ARCHITECTURE graph size and risk formula, BENCHMARK "Road状态" and the accessibility wording, plus every DEMO_MODE default line and the `X-Forwarded-For` line in API.md |
| 15 | LOW | Evacuation-route questions never computed a route; "nearest hospital" listed shelters | Fixed | "evacuat…", "get out", "way out" and "escape" plan as `nearest_shelter`; a resource question filters by the type it names |

## Earlier claims that were incomplete

- **2026-09-17, "hazard-contained destinations" rejected.** True only while the hazard record was fresh (finding 2).
- **2026-09-17, departure advice requires a route recommendation.** True only in the deterministic composer; the LLM path could still send people onto eliminated roads (finding 8).
- **2026-09-17, zero-length approaches checked including exact endpoints.** That check blocked any destination at the end of a closed segment (finding 4b). Zero-length approaches now skip line closures and still check area hazards.
- **BENCHMARK "10 met".** Hand-typed; criterion 1 failed, criterion 2's "closures expire after 4 h" was false (stale closures still block, by design), and criterion 4's probe text did not match the output.

## Behaviour changes a user of the API will notice

- `rejected_reason` has a new value, `hazard_zone`.
- Route summaries no longer always read "avoids N reported hazards": they say "passes through or near N reported hazard areas" or "crosses no reported hazard area" when that is the truth. The recommended action carries the same disclosure.
- More questions get "no route" refuge advice: any destination reachable only through a severe fire, flood or landslide area.
- Demo provider names start `DEMO · `. `npm start` without `DEMO_MODE=1` serves live data only.
- A FEMA shelter or NWS alert missing from a later non-empty poll turns closed or expired within one poll.
- With an LLM key set, `recommended_action` is deterministic text, and no model call is made when no route is verified.
