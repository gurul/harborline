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
