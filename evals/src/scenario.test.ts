/**
 * The §8 acceptance scenario, end to end against a seeded MemoryStore.
 *
 * This is the demo the product is judged on: a wildfire evacuation warning and
 * two closures over the Avenues in Chico, three shelters (one stale, one full),
 * a naive northbound route blocked by a downed-power-line closure on Oleander Ave, and an
 * unverified social report that disputes that closure without ever becoming a
 * fact.
 */
import { describe, expect, it } from "vitest";
import {
  calculateRoutes,
  composeResponse,
  demoGraph,
  edgeIntersectsEvent,
  gatherEvidence,
  nodeId,
  tools,
  validateResponse,
} from "@harborline/agent-tools";
import type { RoadGraph } from "@harborline/agent-tools";
import { CLOSURE_CONTRADICTION_NOTE } from "@harborline/connectors";
import type { CanonicalEvent, LonLat } from "@harborline/event-schema";
import { pointInGeometry } from "@harborline/event-schema";
import {
  DEMO_EVENT_IDS,
  DEMO_RESOURCE_IDS,
  DEMO_USER_LOCATION,
  NOW,
  USER_LAT,
  USER_LON,
  findEvent,
  seedScenario,
} from "./fixtures.js";

const SHELTER_QUESTION = "Where is the nearest open shelter?";

const scenario = seedScenario();
const { store, ctx, fixtures } = scenario;

// ---------------------------------------------------------------------------
// (a) The map/feed layer: what the store returns at the user's location
// ---------------------------------------------------------------------------

describe("(a) queryEvents at the user's location", () => {
  const events = store.queryEvents({
    center: DEMO_USER_LOCATION,
    radius_m: 5000,
    now: NOW,
  });

  it("returns the fire warning and both road closures", () => {
    const ids = events.map((e) => e.event_id);
    expect(ids).toContain(DEMO_EVENT_IDS.fire);
    expect(ids).toContain(DEMO_EVENT_IDS.closureOleander);
    expect(ids).toContain(DEMO_EVENT_IDS.closureMangrove);
  });

  it("ranks the official fire warning first, by severity then freshness", () => {
    expect(events[0]!.event_id).toBe(DEMO_EVENT_IDS.fire);
    expect(events[0]!.severity).toBe("severe");
    expect(events[0]!.best_tier).toBe("A");
    expect(events[0]!.confidence_label).toBe("official");
  });

  it("keeps the fire among the top-severity records", () => {
    const severe = events.filter((e) => e.severity === "severe");
    expect(severe.map((e) => e.event_id)).toContain(DEMO_EVENT_IDS.fire);
    expect(severe.map((e) => e.event_id)).toContain(DEMO_EVENT_IDS.closureOleander);
  });

  it("carries official instructions on the fire warning", () => {
    const instructions = tools.get_official_instructions(ctx, {
      event_id: DEMO_EVENT_IDS.fire,
    });
    expect(instructions).not.toBeNull();
    expect(instructions!.instructions).toMatch(/do not wait for a mandatory order/i);
    expect(instructions!.stale).toBe(false);
    expect(instructions!.providers).toContain("CAL FIRE");
  });
});

// ---------------------------------------------------------------------------
// (b) Shelter selection
// ---------------------------------------------------------------------------

describe("(b) get_nearby_resources", () => {
  const result = tools.get_nearby_resources(ctx, {
    lat: USER_LAT,
    lon: USER_LON,
    resource_type: "shelter",
  });

  it("recommends only Neighborhood Church", () => {
    expect(result.recommendable.map((r) => r.name)).toEqual(["Neighborhood Church"]);
  });

  it("rejects the stale and the full shelter, with reasons", () => {
    const reasons = new Map(
      result.rejected.map((r) => [r.resource.resource_id, r.rejected_reason]),
    );
    expect(reasons.get(DEMO_RESOURCE_IDS.bidwell)).toBe("stale_status");
    expect(reasons.get(DEMO_RESOURCE_IDS.chico)).toBe("full");
    expect(result.rejected).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// (c) Routing
// ---------------------------------------------------------------------------

/**
 * A sub-lattice that forces the eastern detour: E 1st Ave east to Mangrove
 * Ave, north up Mangrove through the fire polygon, then west along E 9th Ave.
 * It exists so the fire-crossing alternative can be scored by the real engine
 * and compared against the recommended western route.
 */
function easternDetourGraph(): RoadGraph {
  const chain: [string, string][] = [
    [nodeId("esplanade", "e_1st_ave"), nodeId("oleander", "e_1st_ave")],
    [nodeId("oleander", "e_1st_ave"), nodeId("arcadian", "e_1st_ave")],
    [nodeId("arcadian", "e_1st_ave"), nodeId("mangrove", "e_1st_ave")],
    [nodeId("mangrove", "e_1st_ave"), nodeId("mangrove", "e_3rd_ave")],
    [nodeId("mangrove", "e_3rd_ave"), nodeId("mangrove", "e_5th_ave")],
    [nodeId("mangrove", "e_5th_ave"), nodeId("mangrove", "e_7th_ave")],
    [nodeId("mangrove", "e_7th_ave"), nodeId("mangrove", "e_9th_ave")],
    [nodeId("mangrove", "e_9th_ave"), nodeId("arcadian", "e_9th_ave")],
    [nodeId("arcadian", "e_9th_ave"), nodeId("oleander", "e_9th_ave")],
    [nodeId("oleander", "e_9th_ave"), nodeId("esplanade", "e_9th_ave")],
  ];
  const allowed = new Set(chain.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  const edges = demoGraph.edges.filter((e) => allowed.has(`${e.from}|${e.to}`));
  expect(edges).toHaveLength(chain.length);

  const used = new Set(edges.flatMap((e) => [e.from, e.to]));
  return { nodes: demoGraph.nodes.filter((n) => used.has(n.id)), edges };
}

describe("(c) calculate_routes — user to Neighborhood Church", () => {
  const routes = tools.calculate_routes(ctx, {
    from_lat: USER_LAT,
    from_lon: USER_LON,
    to_resource_id: DEMO_RESOURCE_IDS.neighborhood,
  });
  const closureOleander = findEvent(fixtures, DEMO_EVENT_IDS.closureOleander);
  const fire = findEvent(fixtures, DEMO_EVENT_IDS.fire);

  it("labels itself a demonstration router", () => {
    expect(routes.routing).toBe("demonstration");
    expect(routes.destination.resource_id).toBe(DEMO_RESOURCE_IDS.neighborhood);
  });

  it("eliminates at least one candidate for crossing the Oleander Ave closure", () => {
    const eliminated = routes.candidates.filter(
      (c) => c.eliminated && c.rejected_reason === "closure_intersection",
    );
    expect(eliminated.length).toBeGreaterThanOrEqual(1);
    expect(
      eliminated.some((c) => c.intersecting_event_ids.includes(DEMO_EVENT_IDS.closureOleander)),
    ).toBe(true);
  });

  it("recommends a surviving route", () => {
    expect(routes.recommendation).not.toBeNull();
    const best = routes.candidates.find(
      (c) => c.route_id === routes.recommendation!.route_id,
    );
    expect(best).toBeDefined();
    expect(best!.eliminated).toBe(false);
  });

  it("keeps the recommended route clear of the Oleander Ave closure", () => {
    const best = routes.candidates.find(
      (c) => c.route_id === routes.recommendation!.route_id,
    )!;
    expect(best.intersecting_event_ids).not.toContain(DEMO_EVENT_IDS.closureOleander);

    // Independent geometric check against the router's own primitive.
    const coords = best.geometry.coordinates as LonLat[];
    for (let i = 0; i < coords.length - 1; i++) {
      expect(edgeIntersectsEvent([coords[i]!, coords[i + 1]!], closureOleander)).toBe(false);
    }
  });

  it("keeps the recommended route out of the fire polygon", () => {
    const best = routes.candidates.find(
      (c) => c.route_id === routes.recommendation!.route_id,
    )!;
    expect(best.intersecting_event_ids).not.toContain(DEMO_EVENT_IDS.fire);
    expect(best.hazard_exposure_m).toBe(0);
    for (const coord of best.geometry.coordinates as LonLat[]) {
      expect(pointInGeometry(coord, fire.geometry)).toBe(false);
    }
  });

  it("scores the eastern detour through the fire polygon worse", () => {
    const activeEvents: CanonicalEvent[] = store.queryEvents({ statuses: ["active"], now: NOW });
    const eastern = calculateRoutes(
      {
        from: DEMO_USER_LOCATION,
        to: [-121.846, 39.7525],
        events: activeEvents,
        now: NOW,
      },
      easternDetourGraph(),
    );

    const detour = eastern.candidates[0]!;
    const best = routes.candidates.find(
      (c) => c.route_id === routes.recommendation!.route_id,
    )!;

    expect(detour.intersecting_event_ids).toContain(DEMO_EVENT_IDS.fire);
    expect(detour.hazard_exposure_m).toBeGreaterThan(0);
    expect(detour.risk_score).toBeGreaterThan(best.risk_score);
    // It also crosses the Mangrove Ave closure, so it never survives to compete.
    expect(detour.eliminated).toBe(true);
    expect(eastern.best).toBeNull();
  });

  it("uses lowest-risk language and never promises safety", () => {
    const summary = routes.recommendation!.summary;
    expect(summary).toContain("Lowest-risk");
    expect(summary).toContain("Conditions may change");
    expect(summary).not.toMatch(/route is safe/i);
    expect(summary).not.toMatch(/\bsafe\b/i);
    expect(routes.recommendation!.routing).toBe("demonstration");
  });
});

// ---------------------------------------------------------------------------
// (d) Composed answer
// ---------------------------------------------------------------------------

describe("(d) composeResponse for the nearest-shelter question", () => {
  const evidence = gatherEvidence(ctx, SHELTER_QUESTION, DEMO_USER_LOCATION);
  const response = composeResponse(SHELTER_QUESTION, evidence, NOW);

  it("names Neighborhood Church", () => {
    expect(response.answer_markdown).toContain("Neighborhood Church");
  });

  it("states why the other two shelters were excluded", () => {
    expect(response.answer_markdown).toContain("Bidwell Community Center");
    expect(response.answer_markdown).toContain("Chico Community Center");
    expect(response.answer_markdown).toContain("Excluded from recommendations");
  });

  it("carries at least one source with a last_verified_at timestamp", () => {
    expect(response.sources.length).toBeGreaterThan(0);
    for (const source of response.sources) {
      expect(source.last_verified_at).toBeTruthy();
      expect(Number.isNaN(new Date(source.last_verified_at).getTime())).toBe(false);
    }
    const shelterSource = response.sources.find(
      (s) => s.provider === "Butte County Emergency Management",
    );
    expect(shelterSource).toBeDefined();
    expect(shelterSource!.last_verified_at).toBe(
      new Date(NOW.getTime() - 8 * 60_000).toISOString(),
    );
  });

  it("states freshness and surfaces the unverified-source caveat", () => {
    expect(response.freshness_note).toMatch(/Most recent source updated/);
    expect(response.uncertainty_note).toBeTruthy();
    expect(response.uncertainty_note!).toMatch(/tier E/);
  });

  it("passes the safety validator", () => {
    const result = validateResponse(response, evidence, NOW);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (e) The unverified contradiction
// ---------------------------------------------------------------------------

describe("(e) the tier E report contradicting the Oleander Ave closure", () => {
  it("annotates the closure instead of overturning it", () => {
    const stored = store.getEvent(DEMO_EVENT_IDS.closureOleander)!;
    expect(stored.event.status).toBe("active");
    expect(stored.event.event_type).toBe("road_closure");
    expect(stored.event.contradiction_note).toBe(CLOSURE_CONTRADICTION_NOTE);
    expect(stored.event.contradiction_note!).toMatch(/not been officially confirmed/i);
  });

  it("never creates an unverified event of its own", () => {
    const tierE = store.allEvents().filter((e) => e.best_tier === "E");
    expect(tierE).toEqual([]);
    expect(store.allEvents()).toHaveLength(fixtures.events.length);
  });

  it("retains the tier E record as separate provenance on the closure", () => {
    const stored = store.getEvent(DEMO_EVENT_IDS.closureOleander)!;
    const providers = stored.source_records.map((r) => r.provider).sort();
    expect(providers).toEqual(["Chico Public Works", "Jim Adrian"]);

    const social = stored.source_records.find((r) => r.provider === "Jim Adrian")!;
    expect(social.provider_tier).toBe("E");
    expect(social.source_record_id).toBe("demo-record-social-oleander");
  });

  it("reports the disagreement through compare_source_records", () => {
    const comparison = tools.compare_source_records(ctx, {
      event_id: DEMO_EVENT_IDS.closureOleander,
    });
    expect(comparison).not.toBeNull();
    expect(comparison!.disagreement).toBe(true);
    expect(comparison!.tiers.sort()).toEqual(["B", "E"]);
    expect(comparison!.contradiction_note).toMatch(/not been officially confirmed/i);
  });
});
