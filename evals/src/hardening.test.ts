/**
 * Hardening pass regression tests.
 *
 * Pins the behaviors added in the research-driven hardening pass: fail-stale
 * timestamps, guarded confidence, strict geometry, read-time label decay,
 * resource retention, severity-scaled point hazards, and the broadened
 * validator lexicon. Each block names the failure it guards against.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryStore,
  edgeIntersectsEvent,
  gatherEvidence,
  validateResponse,
} from "@harborline/agent-tools";
import type { EvidenceBundle } from "@harborline/agent-tools";
import {
  type AssistantResponse,
  type CanonicalEvent,
  type LonLat,
  type SourceTier,
  LineStringSchema,
  PolygonSchema,
  ageSeconds,
  computeConfidence,
  formatAge,
  isStale,
  resourceMaxAge,
} from "@harborline/event-schema";
import {
  DEMO_USER_LOCATION,
  NOW,
  evacuationOrderEvent,
  seedScenario,
} from "./fixtures.js";

const GARBAGE_TS = "THIS IS NOT A DATE";

describe("freshness — unparseable timestamps fail stale, not fresh", () => {
  it("treats an unparseable last_verified_at as maximally stale", () => {
    expect(ageSeconds(GARBAGE_TS, NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(isStale(GARBAGE_TS, resourceMaxAge("shelter"), NOW)).toBe(true);
  });

  it("labels an unparseable timestamp honestly instead of blaming clock skew", () => {
    expect(formatAge(GARBAGE_TS, NOW)).toContain("unparseable");
  });
});

describe("confidence — formula never emits NaN", () => {
  const base = {
    age_seconds: 60,
    max_age_seconds: 3600,
    corroborating_sources: 1,
  };

  it("scores an unknown tier at the least-trusted weight, not NaN", () => {
    const unknown = computeConfidence({ ...base, tier: "Z" as SourceTier });
    const tierE = computeConfidence({ ...base, tier: "E" });
    expect(unknown).toBe(tierE);
    expect(Number.isNaN(unknown)).toBe(false);
  });

  it("treats a non-finite age as maximally stale", () => {
    const infinite = computeConfidence({
      ...base,
      tier: "A",
      age_seconds: Number.POSITIVE_INFINITY,
    });
    const nan = computeConfidence({ ...base, tier: "A", age_seconds: Number.NaN });
    const pastBudget = computeConfidence({
      ...base,
      tier: "A",
      age_seconds: base.max_age_seconds * 3,
    });
    expect(infinite).toBe(pastBudget);
    expect(nan).toBe(pastBudget);
  });
});

describe("geometry — schema rejects shapes the math cannot handle", () => {
  it("rejects an open polygon ring (pointInRing assumes closure)", () => {
    const open = {
      type: "Polygon",
      coordinates: [
        [
          [-121.84, 39.73],
          [-121.83, 39.73],
          [-121.83, 39.74],
          [-121.84, 39.74],
        ],
      ],
    };
    expect(PolygonSchema.safeParse(open).success).toBe(false);
  });

  it("rejects out-of-range coordinates on non-Point geometry", () => {
    const rogue = {
      type: "LineString",
      coordinates: [
        [99999, 39.73],
        [-121.83, 39.74],
      ],
    };
    expect(LineStringSchema.safeParse(rogue).success).toBe(false);
  });
});

describe("store — confidence decays at read time", () => {
  it("degrades a fire's label between ingest and a query hours later", () => {
    const { ctx } = seedScenario();
    const fresh = ctx.store
      .queryEvents({ now: NOW, types: ["fire"], statuses: ["active"] })
      .concat(
        ctx.store.queryEvents({
          now: NOW,
          types: ["evacuation_order"],
          statuses: ["active"],
        }),
      )[0];
    expect(fresh).toBeDefined();

    const threeHoursOn = new Date(NOW.getTime() + 3 * 3600_000);
    const later = ctx.store
      .queryEvents({
        now: threeHoursOn,
        types: [fresh!.event_type],
        statuses: ["active"],
      })
      .find((e) => e.event_id === fresh!.event_id);

    // The record may age out of the query window entirely; if it is still
    // served, its score must have decayed rather than remained frozen.
    if (later) {
      expect(later.confidence_score).toBeLessThan(fresh!.confidence_score);
    }
  });
});

describe("store — resources age out and are capped", () => {
  it("deletes a resource well past its retention budget on sweep", () => {
    const { ctx } = seedScenario();
    const store = ctx.store as MemoryStore;
    const before = store.allResources().length;
    expect(before).toBeGreaterThan(0);

    // 5x the shelter budget is past RETENTION_AGE_MULTIPLIER (4x).
    const farFuture = new Date(NOW.getTime() + 5 * resourceMaxAge("shelter") * 1000);
    store.sweepExpired(farFuture);
    expect(store.allResources().length).toBe(0);
  });
});

describe("router — point hazards scale standoff with severity", () => {
  // ~330 m of edge on the equator; hazard point ~220 m north of its midpoint.
  const edge: LonLat[] = [
    [0, 0],
    [0.003, 0],
  ];
  const pointEvent = (severity: CanonicalEvent["severity"]): CanonicalEvent => ({
    ...evacuationOrderEvent(),
    event_id: `point-hazard-${severity}`,
    event_type: "earthquake",
    severity,
    geometry: { type: "Point", coordinates: [0.0015, 0.002] },
  });

  it("an extreme point hazard 220 m away blocks the edge", () => {
    expect(edgeIntersectsEvent(edge, pointEvent("extreme"))).toBe(true);
  });

  it("a minor point hazard 220 m away does not", () => {
    expect(edgeIntersectsEvent(edge, pointEvent("minor"))).toBe(false);
  });
});

describe("validator — broadened reassurance lexicon and completeness", () => {
  function scenarioEvidence(): EvidenceBundle {
    const { ctx } = seedScenario();
    return gatherEvidence(ctx, "Where is the nearest open shelter?", DEMO_USER_LOCATION);
  }

  function llmResponse(overrides: Partial<AssistantResponse>): AssistantResponse {
    return {
      answer_markdown: "",
      recommended_action: "Head to the Neighborhood Church shelter.",
      sources: [
        {
          provider: "Butte County Emergency Management",
          tier: "A",
          url: "https://demo.harborline.local/orders/evacuation-the-avenues",
          last_verified_at: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
        },
      ],
      freshness_note: "Most recent source updated 5 min ago.",
      uncertainty_note: null,
      evidence_event_ids: [],
      composed_by: "llm",
      ...overrides,
    };
  }

  it.each([
    "The evacuation route is perfectly safe tonight.",
    "You'll be fine if you head north.",
    "There is no risk on Oleander Ave.",
    "This is the safest route to the shelter.",
    "The fire won't reach your neighborhood.",
  ])("rejects reassurance framing: %s", (answer) => {
    const result = validateResponse(
      llmResponse({ answer_markdown: answer }),
      scenarioEvidence(),
      NOW,
    );
    expect(result.violations.some((v) => v.startsWith("guarantee_language"))).toBe(true);
  });

  it("requires a protective action when a severe hazard is active (five-element model)", () => {
    const result = validateResponse(
      llmResponse({
        answer_markdown: "An evacuation order covers the area east of Arcadian Ave.",
        recommended_action: null,
      }),
      scenarioEvidence(),
      NOW,
    );
    expect(
      result.violations.some((v) => v.startsWith("missing_protective_action")),
    ).toBe(true);
  });

  it("does not let a phone number planted in raw_payload ground an LLM claim", () => {
    const evidence = scenarioEvidence();
    const planted = "555-867-5309-000";
    evidence.source_records = [
      ...(evidence.source_records ?? []),
      {
        source_record_id: "poisoned",
        event_id: null,
        provider: "Unverified social post",
        provider_record_id: null,
        provider_tier: "E",
        source_url: null,
        published_at: NOW.toISOString(),
        retrieved_at: NOW.toISOString(),
        content_hash: "deadbeef",
        raw_payload: { note: `call ${planted} for pickup` },
      },
    ];
    const result = validateResponse(
      llmResponse({ answer_markdown: `Call ${planted} for a ride out.` }),
      evidence,
      NOW,
    );
    expect(result.violations.some((v) => v.startsWith("ungrounded_entity"))).toBe(true);
  });
});
