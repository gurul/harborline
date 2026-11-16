/**
 * Safety rules for the two fire feeds (satellite heat detections and
 * interagency perimeters).
 *
 * A detection is unconfirmed: it never eliminates a route, it adds a fixed
 * penalty, it triggers a detour search, and it is disclosed. Only a two-pass
 * severe cluster rejects a shelter. A perimeter under 50 percent contained
 * eliminates a crossing route like any severe fire area.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryStore,
  buildRecommendation,
  calculateRoutes,
  composeResponse,
  demoGraph,
  immediateHazardNote,
  tools,
  validateResponse,
  type EvidenceBundle,
  type RoadGraph,
} from "@harborline/agent-tools";
import { makeEvent, makeSourceRecord } from "@harborline/connectors";
import type {
  CanonicalEvent,
  EventType,
  LonLat,
  NearbyResource,
  Severity,
} from "@harborline/event-schema";
import { DEMO_RESOURCE_IDS, DEMO_USER_LOCATION, NOW, findResource, seedScenario } from "./fixtures.js";

const HOUR = 3600_000;

/** Axis-aligned square of `halfM` metres around a point. */
function square(center: LonLat, halfM: number): LonLat[][] {
  const dLat = halfM / 111_320;
  const dLon = halfM / (111_320 * Math.cos((center[1] * Math.PI) / 180));
  const [x, y] = center;
  return [[
    [x - dLon, y - dLat],
    [x + dLon, y - dLat],
    [x + dLon, y + dLat],
    [x - dLon, y + dLat],
    [x - dLon, y - dLat],
  ]];
}

function areaEvent(
  id: string,
  type: EventType,
  severity: Severity,
  center: LonLat,
  halfM: number,
  opts: { urgency?: CanonicalEvent["urgency"]; ageMin?: number } = {},
): CanonicalEvent {
  const verified = new Date(NOW.getTime() - (opts.ageMin ?? 60) * 60_000).toISOString();
  return makeEvent(
    {
      event_id: id,
      event_type: type,
      headline: `${type} ${id}`,
      description: "test record",
      severity,
      urgency: opts.urgency ?? "unknown",
      certainty: "likely",
      geometry: { type: "Polygon", coordinates: square(center, halfM) },
      starts_at: verified,
      ends_at: type === "fire_detection" ? new Date(new Date(verified).getTime() + 24 * HOUR).toISOString() : null,
      last_verified_at: verified,
      best_tier: type === "fire_detection" ? "C" : "B",
    },
    NOW,
  );
}

// One straight north-south road, about 1.1 km long.
const A: LonLat = [-121.84, 39.74];
const B: LonLat = [-121.84, 39.75];
const MID: LonLat = [-121.84, 39.745];
const ONE_ROAD: RoadGraph = {
  nodes: [
    { id: "a", coord: A, name: "A" },
    { id: "b", coord: B, name: "B" },
  ],
  edges: [{ from: "a", to: "b", name: "Only Rd", geometry: [A, B] }],
};

// The same road plus a detour about 10 km long: about 20 min at 30 km/h
// against 2 min on the short road. Exposure on the short road (1.1 km, about
// 11 risk units) alone does not pay for that detour; the detection penalty does.
const C: LonLat = [-121.788, 39.74];
const D: LonLat = [-121.788, 39.75];
const WITH_DETOUR: RoadGraph = {
  nodes: [
    ...ONE_ROAD.nodes,
    { id: "c", coord: C, name: "C" },
    { id: "d", coord: D, name: "D" },
  ],
  edges: [
    ...ONE_ROAD.edges,
    { from: "a", to: "c", name: "South Rd", geometry: [A, C] },
    { from: "c", to: "d", name: "East Rd", geometry: [C, D] },
    { from: "d", to: "b", name: "North Rd", geometry: [D, B] },
  ],
};

function shelterAt(location: LonLat): NearbyResource {
  const { fixtures } = seedScenario();
  const template = findResource(fixtures, DEMO_RESOURCE_IDS.neighborhood);
  return { ...template, resource_id: "test-shelter", name: "Test Shelter", location: { type: "Point", coordinates: location }, distance_m: 1100 };
}

describe("S1: a detection on the only road keeps the route and discloses it", () => {
  const detection = areaEvent("det-only-road", "fire_detection", "moderate", MID, 300);

  it("keeps the route, not eliminated, with the detection in intersecting_event_ids", () => {
    const { best, candidates } = calculateRoutes({ from: A, to: B, events: [detection], now: NOW }, ONE_ROAD);
    expect(best).not.toBeNull();
    expect(best!.eliminated).toBe(false);
    expect(best!.intersecting_event_ids).toContain(detection.event_id);
    expect(candidates.every((c) => !c.eliminated)).toBe(true);
  });

  it("names the satellite detection in the summary and in the recommended action", () => {
    const { best, candidates } = calculateRoutes({ from: A, to: B, events: [detection], now: NOW }, ONE_ROAD);
    const shelter = shelterAt(B);
    const recommendation = buildRecommendation(best!, shelter, [detection.event_id], NOW, [detection]);
    expect(recommendation.summary).toMatch(/1 satellite heat detection, unconfirmed by a fire agency, detected 1 h ago/);
    expect(recommendation.summary).toContain("passes through or near 1 reported hazard area");

    const bundle: EvidenceBundle = {
      events: [detection],
      resources: [shelter],
      rejected_resources: [],
      route: { candidates, recommendation, destination: shelter },
    };
    const response = composeResponse("Where is the nearest open shelter?", bundle, NOW);
    expect(response.recommended_action).toMatch(/satellite heat detection, unconfirmed by a fire agency/);
    expect(response.answer_markdown).toMatch(/satellite heat detection/);
  });
});

describe("S2: a 3 km detection footprint over the whole demo grid", () => {
  it("still leaves a recommendable route, where an official severe fire area would not", () => {
    const shelter = findResource(seedScenario().fixtures, DEMO_RESOURCE_IDS.neighborhood);
    const to = shelter.location.coordinates as LonLat;
    const center: LonLat = [-121.84, 39.7465];
    const detection = areaEvent("det-modis", "fire_detection", "severe", center, 1500);
    const kept = calculateRoutes({ from: DEMO_USER_LOCATION, to, events: [detection], now: NOW }, demoGraph);
    expect(kept.best).not.toBeNull();
    expect(kept.best!.intersecting_event_ids).toContain("det-modis");

  });

  it("keeps a route through a band across every road, which an official severe fire would cut", () => {
    const shelter = findResource(seedScenario().fixtures, DEMO_RESOURCE_IDS.neighborhood);
    const to = shelter.location.coordinates as LonLat;
    // A band between the user (south) and the shelter (north), over every road.
    const band = (id: string, type: EventType): CanonicalEvent => ({
      ...areaEvent(id, type, "severe", [-121.84, 39.7465], 100),
      geometry: { type: "Polygon", coordinates: [[[-121.85, 39.7455], [-121.83, 39.7455], [-121.83, 39.7475], [-121.85, 39.7475], [-121.85, 39.7455]]] },
    });
    expect(DEMO_USER_LOCATION[1]).toBeLessThan(39.7455);
    expect(to[1]).toBeGreaterThan(39.7475);
    const kept = calculateRoutes({ from: DEMO_USER_LOCATION, to, events: [band("det-band", "fire_detection")], now: NOW }, demoGraph);
    expect(kept.best).not.toBeNull();
    const cut = calculateRoutes({ from: DEMO_USER_LOCATION, to, events: [band("fire-band", "fire")], now: NOW }, demoGraph);
    expect(cut.best).toBeNull();
  });
});

describe("S3: a detour more than 3 minutes longer beats a road through a detection", () => {
  it("chooses the detour for a moderate detection", () => {
    const detection = areaEvent("det-short", "fire_detection", "moderate", MID, 200);
    const { best } = calculateRoutes({ from: A, to: B, events: [detection], now: NOW }, WITH_DETOUR);
    expect(best).not.toBeNull();
    expect(best!.intersecting_event_ids).not.toContain("det-short");
    expect(best!.duration_min).toBeGreaterThan(15);
  });

  it("keeps the short road when the detection carries no penalty (low confidence only)", () => {
    const detection = areaEvent("det-low", "fire_detection", "minor", MID, 200);
    const { best } = calculateRoutes({ from: A, to: B, events: [detection], now: NOW }, WITH_DETOUR);
    expect(best!.intersecting_event_ids).toContain("det-low");
  });
});

describe("S4: shelters near detections", () => {
  function storeWith(severity: Severity) {
    const store = new MemoryStore();
    const shelter = shelterAt(B);
    const { distance_m: _d, ...resource } = shelter;
    store.upsertResource({ ...resource, last_verified_at: new Date(NOW.getTime() - 10 * 60_000).toISOString() });
    store.upsertEvent(areaEvent("det-shelter", "fire_detection", severity, B, 300), [
      makeSourceRecord({
        source_record_id: "rec-det-shelter",
        event_id: "det-shelter",
        provider: "NASA FIRMS",
        provider_record_id: null,
        provider_tier: "C",
        source_url: null,
        published_at: new Date(NOW.getTime() - HOUR).toISOString(),
        retrieved_at: NOW.toISOString(),
        hash_input: "det-shelter",
      }),
    ]);
    return tools.get_nearby_resources({ store, now: NOW }, { lat: B[1], lon: B[0], resource_type: "shelter" });
  }

  it("keeps a shelter inside a moderate cluster recommendable and names a caution", () => {
    const result = storeWith("moderate");
    expect(result.recommendable.map((r) => r.resource_id)).toContain("test-shelter");
    expect(result.cautions).toHaveLength(1);
    expect(result.cautions[0]!.note).toMatch(/satellite heat detection at this location, detected 1 h ago, unconfirmed/);
  });

  it("rejects a shelter inside a severe (two-pass) cluster as inside_hazard_zone", () => {
    const result = storeWith("severe");
    expect(result.recommendable).toHaveLength(0);
    expect(result.rejected[0]!.rejected_reason).toBe("inside_hazard_zone");
  });
});

describe("S5: perimeters", () => {
  it("a perimeter under 50 percent contained (severe) eliminates the crossing route", () => {
    const perimeter = areaEvent("perim-open", "fire_perimeter", "severe", MID, 300);
    const result = calculateRoutes({ from: A, to: B, events: [perimeter], now: NOW }, ONE_ROAD);
    expect(result.best).toBeNull();
    expect(result.candidates[0]!.rejected_reason).toBe("hazard_zone");
  });

  it("a mostly contained perimeter (moderate) does not eliminate", () => {
    const perimeter = areaEvent("perim-held", "fire_perimeter", "moderate", MID, 300);
    const result = calculateRoutes({ from: A, to: B, events: [perimeter], now: NOW }, ONE_ROAD);
    expect(result.best).not.toBeNull();
    expect(result.best!.intersecting_event_ids).toContain("perim-held");
  });
});

describe("S6: detections never add the act-now note", () => {
  it("ignores a severe, immediate detection but not the same record as an official fire", () => {
    const detection = areaEvent("det-now", "fire_detection", "severe", MID, 300, { urgency: "immediate" });
    expect(immediateHazardNote({ events: [detection] })).toBeNull();
    const fire = areaEvent("fire-now", "fire", "severe", MID, 300, { urgency: "immediate" });
    expect(immediateHazardNote({ events: [fire] })).toMatch(/zone-by-zone/);
  });
});

describe("S7: the validator rejects fire and air claims the evidence cannot support", () => {
  function airEvidence(status: "ok" | "stale", aqi: number, category: string): EvidenceBundle {
    const verified = new Date(NOW.getTime() - (status === "ok" ? 30 : 300) * 60_000).toISOString();
    return {
      events: [],
      environment: {
        generated_at: NOW.toISOString(),
        radius_m: 25_000,
        air_quality: {
          status, aqi, category, pollutant: "PM2.5", name: "Chico, CA", distance_m: 900,
          provider: "AirNow (EPA and partner agencies)", provider_tier: "B",
          source_url: "https://www.airnow.gov/", last_verified_at: verified, age_label: "x",
        },
        stream_gauge: { status: "no_data" },
        smoke: { status: "no_data" },
        fire: { status: "ok", detections: 0, perimeters: 0, confirmed: false, note: "" },
        power: { status: "not_monitored", note: "" },
        sources: [],
      },
    };
  }
  const answer = (text: string, composed_by: "llm" | "deterministic" = "llm") => ({
    answer_markdown: text,
    recommended_action: "Keep checking official updates.",
    sources: [{ provider: "AirNow (EPA and partner agencies)", tier: "B" as const, url: "https://www.airnow.gov/", last_verified_at: NOW.toISOString() }],
    freshness_note: "Air quality reported 30 min ago.",
    uncertainty_note: null,
    evidence_event_ids: [],
    composed_by,
  });
  const violations = (text: string, evidence: EvidenceBundle, by?: "llm" | "deterministic") =>
    validateResponse(answer(text, by), evidence, NOW).violations.join(" | ");

  it("rejects a claim that there is no fire, and allows the not-proof wording", () => {
    const evidence = airEvidence("ok", 42, "Good");
    expect(violations("There is no fire near you.", evidence)).toMatch(/no_fire_claim/);
    expect(violations("The area is fire-free.", evidence)).toMatch(/no_fire_claim/);
    expect(violations("A missing detection is not proof of no fire.", evidence)).not.toMatch(/no_fire_claim/);
  });

  it("rejects a statement that the air is safe", () => {
    expect(violations("The air is safe to breathe.", airEvidence("ok", 42, "Good"))).toMatch(/safe/);
    expect(violations("It is safe to go outside.", airEvidence("ok", 42, "Good"))).toMatch(/safe/);
    expect(violations("Air quality at Chico, CA: AQI 42.", airEvidence("ok", 42, "Good"))).not.toMatch(/safe/);
  });

  it("rejects an AQI number or category the evidence does not give", () => {
    const evidence = airEvidence("ok", 42, "Good");
    expect(violations("AQI 42 at Chico, CA.", evidence)).not.toMatch(/aqi_/);
    expect(violations("AQI 87 at Chico, CA.", evidence)).toMatch(/aqi_mismatch/);
    expect(violations("Air quality is in the Unhealthy range.", evidence)).toMatch(/aqi_category_mismatch/);
    expect(violations("AQI 42 at Chico, CA.", { events: [] })).toMatch(/aqi_mismatch/);
  });

  it("rejects a stale reading stated as current, on both paths", () => {
    const stale = airEvidence("stale", 42, "Good");
    expect(violations("The air quality is good.", stale)).toMatch(/stale_claim_as_current/);
    expect(violations("The air quality is good.", stale, "deterministic")).toMatch(/stale_claim_as_current/);
    expect(violations("The air quality is good.", airEvidence("ok", 42, "Good"))).not.toMatch(/stale_claim_as_current/);
  });
});

describe("S8: the risk breakdown adds up and names the detection penalty", () => {
  it("reports the fixed penalty on its own line, not as a stale-data penalty", () => {
    const detection = areaEvent("det-score", "fire_detection", "moderate", MID, 300);
    const { best, candidates } = calculateRoutes({ from: A, to: B, events: [detection], now: NOW }, ONE_ROAD);
    const breakdown = tools.score_route_risk({ store: new MemoryStore(), now: NOW }, { route_id: best!.route_id, candidates });
    expect(breakdown).not.toBeNull();
    const b = breakdown!.breakdown;
    expect(b.detection_penalty).toBe(15);
    expect(b.stale_data_penalty).toBe(0);
    expect(b.travel_minutes + b.hazard_penalty + b.detection_penalty + b.stale_data_penalty).toBeCloseTo(breakdown!.risk_score, 6);
  });

  it("still reports a stale record's penalty as stale", () => {
    const old = areaEvent("det-old", "fire_detection", "moderate", MID, 300, { ageMin: 7 * 60 });
    const { best, candidates } = calculateRoutes({ from: A, to: B, events: [old], now: NOW }, ONE_ROAD);
    const b = tools.score_route_risk({ store: new MemoryStore(), now: NOW }, { route_id: best!.route_id, candidates })!.breakdown;
    expect(b.stale_data_penalty).toBe(5);
    expect(b.detection_penalty).toBe(15);
  });
});
