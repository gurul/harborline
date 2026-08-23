/**
 * Real-to-sim replay: the 2018 Camp Fire timeline mapped onto the Harborline
 * demo scenario (docs/BENCHMARK.md carries the full mapping + citations).
 *
 * Real geography → sim geography:
 *   Paradise ridge / fire front      → the seeded severe fire polygon, east Chico
 *   Pentz Rd / Skyway egress network → the demo road lattice (Oleander, Mangrove)
 *   Feather River Hospital           → hospital placed inside the fire polygon
 *   Neighborhood Church of Chico     → the same-named demo shelter (it was a
 *                                      real Camp Fire shelter in Nov 2018)
 *
 * Real clock → sim clock: T0 is first report (06:25 PST, Butte County DA
 * report p.8). Each block below advances `now` and asserts what an ideal
 * system should have said at that moment, per the documented record.
 */
import { describe, expect, it } from "vitest";
import {
  composeResponse,
  gatherEvidence,
  tools,
  validateResponse,
} from "@harborline/agent-tools";
import {
  eventMaxAge,
  isStale,
  resourceMaxAge,
  type Resource,
} from "@harborline/event-schema";
import {
  DEMO_RESOURCE_IDS,
  USER_LAT,
  USER_LON,
  findResource,
  seedScenario,
} from "./fixtures.js";

const SHELTER_QUESTION = "Where is the nearest open shelter?";

/** T0 — first 911 report reaches CAL FIRE ECC (06:25 PST, DA report). */
const T0 = new Date("2018-11-08T14:25:00Z"); // 06:25 PST
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe("real2sim: T0+0 — first report (06:25). Records precede orders.", () => {
  // Camp Fire: the fire was real at 06:25; the first evacuation order came at
  // 07:23 and Paradise's zone orders at 07:46+ — after the fire had arrived
  // (07:44). Criterion 4: advice must flow from observations, never be gated
  // on "an order exists for your zone".
  const { ctx } = seedScenario(T0);

  it("surfaces the active fire for the user with no evacuation_order on file", () => {
    const result = tools.get_active_events(ctx, {
      lat: USER_LAT,
      lon: USER_LON,
      radius_m: 8_000,
    });
    const types = result.events.map((e) => e.event_type);
    expect(types).toContain("fire");
    expect(types).not.toContain("evacuation_order"); // no order yet — fire shows anyway
  });

  it("stamps every surfaced event with provenance age (criterion 12)", () => {
    const result = tools.get_active_events(ctx, {
      lat: USER_LAT,
      lon: USER_LON,
      radius_m: 8_000,
    });
    for (const event of result.events) {
      expect(event.age_label).toBeTruthy();
      expect(event.providers.length).toBeGreaterThan(0);
    }
  });
});

describe("real2sim: T0+80m — fire inside town (07:45). The Feather River rule.", () => {
  // Feather River Hospital was evacuating ~67-80 patients mid-procedure while
  // still nominally "a hospital". Criterion 8: a facility inside the hazard
  // footprint is not a destination, whatever its own record says.
  const now = minutes(80);
  const { store, ctx } = seedScenario(now);

  const template = findResource(seedScenario(now).fixtures, DEMO_RESOURCE_IDS.neighborhood);
  const featherRiverAnalog: Resource = {
    ...template,
    resource_id: "sim-feather-river-hospital",
    resource_type: "hospital",
    name: "Ridge Hospital (in fire zone)",
    location: { type: "Point", coordinates: [-121.834, 39.745] }, // inside polygon
    operational_status: "open",
    last_verified_at: now.toISOString(), // perfectly fresh — and still wrong to send anyone there
  };
  store.upsertResource(featherRiverAnalog);

  it("rejects the fresh, open, in-zone hospital with inside_hazard_zone", () => {
    const result = tools.get_nearby_resources(ctx, {
      lat: USER_LAT,
      lon: USER_LON,
      resource_type: "hospital",
    });
    const rejectedIds = result.rejected.map((r) => r.resource.resource_id);
    expect(rejectedIds).toContain(featherRiverAnalog.resource_id);
    expect(
      result.rejected.find((r) => r.resource.resource_id === featherRiverAnalog.resource_id)!
        .rejected_reason,
    ).toBe("inside_hazard_zone");
    expect(result.recommendable.map((r) => r.resource_id)).not.toContain(
      featherRiverAnalog.resource_id,
    );
  });
});

describe("real2sim: T0+2h35m — arteries closing (09:00, Pentz closed).", () => {
  // NIST TN 2252: every egress artery closed at least once; >=2 of 4 closed
  // simultaneously for 68% of 08:00-14:15. Criteria 1+2: routes crossing a
  // reported closure are eliminated, not discounted, and survivors are risk-
  // ranked — never called "safe".
  const now = minutes(155);
  const { ctx } = seedScenario(now);

  const routes = tools.calculate_routes(ctx, {
    from_lat: USER_LAT,
    from_lon: USER_LON,
    to_resource_id: DEMO_RESOURCE_IDS.neighborhood,
  });

  it("eliminates closure-crossing candidates outright", () => {
    const eliminated = routes.candidates.filter((c) => c.eliminated);
    expect(eliminated.length).toBeGreaterThan(0);
    for (const candidate of eliminated) {
      expect(["closure_intersection", "evacuation_zone", "no_path"]).toContain(
        candidate.rejected_reason,
      );
    }
  });

  it("still recommends a surviving route, hedged as lowest-risk", () => {
    expect(routes.recommendation).not.toBeNull();
    expect(routes.recommendation!.summary.toLowerCase()).toContain("lowest-risk");
    expect(routes.recommendation!.summary.toLowerCase()).not.toContain(" safe");
  });

  it("keeps routing honest about being a demonstration", () => {
    expect(routes.routing).toBe("demonstration");
  });
});

describe("real2sim: road status is perishable (criterion 2)", () => {
  // Skyway's status changed repeatedly through the morning. A closure report
  // must expire from the recommendation basis, not live forever.
  it("expires a road_closure record after its 4 h freshness budget", () => {
    const maxAge = eventMaxAge("road_closure");
    expect(maxAge).toBe(4 * 3600);
    const reportedAt = T0.toISOString();
    expect(isStale(reportedAt, maxAge, minutes(3 * 60))).toBe(false);
    expect(isStale(reportedAt, maxAge, minutes(5 * 60))).toBe(true);
  });

  it("expires a shelter status after 24 h (the Bidwell rule)", () => {
    const maxAge = resourceMaxAge("shelter");
    expect(isStale(T0.toISOString(), maxAge, minutes(23 * 60))).toBe(false);
    expect(isStale(T0.toISOString(), maxAge, minutes(25 * 60))).toBe(true);
  });
});

describe("real2sim: every artery cut → refuge-in-place guidance (criterion 3)", () => {
  // NIST TN 2252: all five egress arteries out of Paradise closed at least
  // once; 31 improvised temporary refuge areas (parking lots, cleared ground)
  // held 1,200+ people whose routes were gone. When every candidate route is
  // eliminated, the answer must say so and give refuge direction — not go
  // silent.
  const { store, ctx, fixtures } = seedScenario();
  const template = fixtures.events.find((e) => e.event_type === "road_closure")!;
  // One wide east-west closure between the user and every shelter cuts every
  // northbound path in the demonstration lattice.
  store.upsertEvent(
    {
      ...template,
      event_id: "sim-barrier-all-arteries",
      headline: "All northbound arteries closed by fire",
      geometry: {
        type: "LineString",
        coordinates: [
          [-121.9, 39.746],
          [-121.78, 39.746],
        ],
      },
    },
    [],
  );

  const routes = tools.calculate_routes(ctx, {
    from_lat: USER_LAT,
    from_lon: USER_LON,
    to_resource_id: DEMO_RESOURCE_IDS.neighborhood,
  });

  it("eliminates every candidate and recommends nothing", () => {
    expect(routes.candidates.length).toBeGreaterThan(0);
    expect(routes.candidates.every((c) => c.eliminated)).toBe(true);
    expect(routes.recommendation).toBeNull();
  });

  it("composes explicit no-route + refuge-in-place guidance that passes the validator", () => {
    const evidence = gatherEvidence(ctx, SHELTER_QUESTION, [USER_LON, USER_LAT]);
    const response = composeResponse(SHELTER_QUESTION, evidence, ctx.now);
    expect(response.answer_markdown).toContain(
      "No route is currently verified as passable",
    );
    expect(response.answer_markdown).toContain("cleared");
    const check = validateResponse(response, evidence, ctx.now);
    expect(check.violations).toEqual([]);
  });
});

describe("real2sim: immediate hazard outruns staged orders (criterion 6)", () => {
  // The fire entered Paradise at 07:44 — two minutes before the town's first
  // zone order. An `immediate`-urgency severe hazard must trigger "act on
  // conditions now", not "wait for your zone's instruction".
  const { ctx } = seedScenario();

  it("appends the act-now note when an immediate severe hazard is active", () => {
    const evidence = gatherEvidence(ctx, SHELTER_QUESTION, [USER_LON, USER_LAT]);
    const response = composeResponse(SHELTER_QUESTION, evidence, ctx.now);
    expect(response.answer_markdown).toContain("marked immediate");
    expect(response.answer_markdown).toContain(
      "rather than waiting for a zone-by-zone instruction",
    );
    const check = validateResponse(response, evidence, ctx.now);
    expect(check.violations).toEqual([]);
  });
});

describe("real2sim: shelter health advisories and the named plan B (criteria 7 + 11)", () => {
  // Norovirus ran through four official Camp Fire shelters (140+ symptomatic)
  // while every one stayed "open"; overflow arrivals had no plan B and ended
  // up in the Walmart parking lot. The advisory must be surfaced with the
  // recommendation, and the fallback destination must be named.
  const { store, ctx } = seedScenario();
  const template = findResource(seedScenario().fixtures, DEMO_RESOURCE_IDS.neighborhood);
  store.upsertResource({
    ...template,
    resource_id: "sim-shelter-advisory",
    name: "Downtown Gym Shelter",
    location: { type: "Point", coordinates: [USER_LON, USER_LAT + 0.0015] },
    operational_status: "open",
    health_advisory: "Norovirus outbreak reported by county public health",
    last_verified_at: ctx.now.toISOString(),
  });

  const evidence = gatherEvidence(ctx, SHELTER_QUESTION, [USER_LON, USER_LAT]);
  const response = composeResponse(SHELTER_QUESTION, evidence, ctx.now);

  it("surfaces the health advisory on the nearest open shelter", () => {
    expect(response.answer_markdown).toContain("Downtown Gym Shelter");
    expect(response.answer_markdown).toContain(
      "Health advisory: Norovirus outbreak reported by county public health",
    );
  });

  it("names the fallback destination explicitly", () => {
    expect(response.answer_markdown).toContain(
      "If it is full when you arrive, next option: Neighborhood Church",
    );
  });

  it("still passes the safety validator", () => {
    const check = validateResponse(response, evidence, ctx.now);
    expect(check.violations).toEqual([]);
  });
});

describe("real2sim: accessibility-aware ranking (criterion 10)", () => {
  // Camp Fire victims skewed elderly and mobility-limited (average age ~72).
  // When the question asks for accessibility, a verified-accessible shelter
  // outranks a marginally nearer one with no recorded accessibility features.
  const { store, ctx } = seedScenario();
  const template = findResource(seedScenario().fixtures, DEMO_RESOURCE_IDS.neighborhood);
  store.upsertResource({
    ...template,
    resource_id: "sim-shelter-no-access",
    name: "Corner Store Annex",
    location: { type: "Point", coordinates: [USER_LON, USER_LAT + 0.001] },
    operational_status: "open",
    accessibility_features: [],
    last_verified_at: ctx.now.toISOString(),
  });

  it("prefers the accessible shelter when the question asks for it", () => {
    const question = "Where is the nearest wheelchair accessible shelter?";
    const evidence = gatherEvidence(ctx, question, [USER_LON, USER_LAT]);
    const response = composeResponse(question, evidence, ctx.now);
    expect(response.answer_markdown).toContain(
      "The nearest open shelter is **Neighborhood Church**",
    );
    expect(response.answer_markdown).toContain("Accessibility: wheelchair_accessible");
    const check = validateResponse(response, evidence, ctx.now);
    expect(check.violations).toEqual([]);
  });

  it("keeps plain distance order when accessibility is not asked about", () => {
    const evidence = gatherEvidence(ctx, SHELTER_QUESTION, [USER_LON, USER_LAT]);
    const response = composeResponse(SHELTER_QUESTION, evidence, ctx.now);
    expect(response.answer_markdown).toContain(
      "The nearest open shelter is **Corner Store Annex**",
    );
  });
});

describe("real2sim: shelter capacity honesty (criterion 7)", () => {
  // Oroville Nazarene reached 352 occupants; the spontaneous Walmart camp
  // formed because official shelters overflowed. A full shelter is surfaced
  // as full — never silently recommended.
  const { ctx } = seedScenario(T0);

  it("rejects the at-capacity shelter with reason 'full', keeps it visible", () => {
    const result = tools.get_nearby_resources(ctx, {
      lat: USER_LAT,
      lon: USER_LON,
      resource_type: "shelter",
    });
    const full = result.rejected.find(
      (r) => r.resource.resource_id === DEMO_RESOURCE_IDS.chico,
    );
    expect(full).toBeDefined();
    expect(full!.rejected_reason).toBe("full");
    expect(full!.resource.capacity_available).toBe(0);
  });
});
