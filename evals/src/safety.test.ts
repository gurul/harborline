/**
 * Safety-policy validator (BUILD_GUIDE §5, §7).
 *
 * One case per violation class, plus the guarantee that the deterministic
 * composer's own output passes. The doctored answers are the point: they are
 * the shapes an LLM would produce if it were allowed to originate facts.
 */
import { describe, expect, it } from "vitest";
import {
  composeResponse,
  gatherEvidence,
  validateResponse,
} from "@harborline/agent-tools";
import type { EvidenceBundle } from "@harborline/agent-tools";
import type { AssistantResponse } from "@harborline/event-schema";
import {
  DEMO_RESOURCE_IDS,
  DEMO_USER_LOCATION,
  NOW,
  asNearby,
  evacuationOrderEvent,
  evacuationOrderRecord,
  findResource,
  seedScenario,
} from "./fixtures.js";

const SHELTER_QUESTION = "Where is the nearest open shelter?";

function scenarioEvidence(): EvidenceBundle {
  const { ctx } = seedScenario();
  return gatherEvidence(ctx, SHELTER_QUESTION, DEMO_USER_LOCATION);
}

/** A response that is well-formed apart from the field under test. */
function baseResponse(overrides: Partial<AssistantResponse> = {}): AssistantResponse {
  return {
    answer_markdown: "",
    recommended_action: null,
    sources: [
      {
        provider: "Chico Public Works",
        tier: "B",
        url: "https://demo.harborline.local/closures/oleander-ave",
        last_verified_at: new Date(NOW.getTime() - 22 * 60_000).toISOString(),
      },
    ],
    freshness_note: "Most recent source updated 6 min ago.",
    uncertainty_note: null,
    evidence_event_ids: [],
    composed_by: "llm",
    ...overrides,
  };
}

function violationKinds(violations: string[]): string[] {
  return violations.map((v) => v.split(":")[0] ?? v);
}

describe("validateResponse — violation classes", () => {
  it("rejects guarantee language about a route", () => {
    const evidence = scenarioEvidence();
    const response = baseResponse({
      answer_markdown:
        "Route via Oleander Ave — this route is safe. Head north and then west to the shelter.",
      recommended_action: "Take Oleander Ave north.",
    });

    const result = validateResponse(response, evidence, NOW);

    expect(result.ok).toBe(false);
    expect(violationKinds(result.violations)).toContain("guarantee_language");
    expect(result.violations.some((v) => /route is safe/i.test(v))).toBe(true);
  });

  it("rejects a response that cites no sources", () => {
    const evidence = scenarioEvidence();
    const response = baseResponse({
      answer_markdown:
        "The nearest shelter is Neighborhood Church, about 1.5 km north of you.",
      sources: [],
    });

    const result = validateResponse(response, evidence, NOW);

    expect(result.ok).toBe(false);
    expect(violationKinds(result.violations)).toContain("missing_sources");
  });

  it("rejects describing a 26-hour-old shelter record as current", () => {
    const { fixtures } = seedScenario();
    const bidwell = asNearby(findResource(fixtures, DEMO_RESOURCE_IDS.bidwell));

    // The ONLY evidence is the stale record — nothing here supports a
    // present-tense claim about the shelter.
    const evidence: EvidenceBundle = {
      events: [],
      resources: [],
      rejected_resources: [{ resource: bidwell, rejected_reason: "stale_status" }],
      source_records: [],
    };

    const response = baseResponse({
      answer_markdown:
        "Bidwell Community Center is open right now — head there and check in at the door.",
      sources: [
        {
          provider: bidwell.provider,
          tier: bidwell.provider_tier,
          url: bidwell.source_url,
          last_verified_at: bidwell.last_verified_at,
        },
      ],
    });

    const result = validateResponse(response, evidence, NOW);

    expect(result.ok).toBe(false);
    expect(violationKinds(result.violations)).toContain("stale_claim_as_current");
    expect(
      result.violations.some((v) => v.includes("Bidwell Community Center")),
    ).toBe(true);
  });

  it("rejects shelter-in-place advice while an evacuation order is in evidence", () => {
    const { fixtures } = seedScenario();
    const evacuation = evacuationOrderEvent();

    const evidence: EvidenceBundle = {
      events: [evacuation, ...fixtures.events],
      source_records: [evacuationOrderRecord(), ...fixtures.source_records],
    };

    const response = baseResponse({
      answer_markdown:
        "Smoke is heavy across the Avenues. The best thing to do is stay home until it clears.",
      recommended_action: "Stay home and wait for further updates.",
    });

    const result = validateResponse(response, evidence, NOW);

    expect(result.ok).toBe(false);
    expect(violationKinds(result.violations)).toContain("contradicts_evacuation_order");
  });

  it("passes the deterministic composer's nearest-shelter answer", () => {
    const { ctx } = seedScenario();
    const evidence = gatherEvidence(ctx, SHELTER_QUESTION, DEMO_USER_LOCATION);
    const response = composeResponse(SHELTER_QUESTION, evidence, NOW);

    const result = validateResponse(response, evidence, NOW);

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(response.composed_by).toBe("deterministic");
  });
});

describe("guarantee-language regression corpus", () => {
  const corpus = [
    "This route is safe for you to take.",
    "The detour is completely safe.",
    "It is totally safe to cross here.",
    "This road is 100% safe right now.",
    "Arrival is guaranteed within ten minutes.",
    "We guarantee the shelter will have space.",
    "There is no danger on this street.",
    "It is safe to walk through the underpass.",
  ];

  it.each(corpus)("rejects: %s", (answer) => {
    const evidence = scenarioEvidence();
    const result = validateResponse(baseResponse({ answer_markdown: answer }), evidence, NOW);

    expect(result.ok).toBe(false);
    expect(violationKinds(result.violations)).toContain("guarantee_language");
  });

  it("does not flag the composer's lowest-risk wording", () => {
    const evidence = scenarioEvidence();
    const response = composeResponse(SHELTER_QUESTION, evidence, NOW);

    expect(response.answer_markdown).toContain("Lowest-risk route currently available");
    expect(response.answer_markdown).not.toMatch(/route is safe/i);
    expect(validateResponse(response, evidence, NOW).ok).toBe(true);
  });
});
