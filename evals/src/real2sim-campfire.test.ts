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
 * report p.8). The scenario is seeded ONCE at T0 and every checkpoint queries
 * it at T0+n, so records age between checkpoints the way they would in a real
 * morning. A block that adds records seeds its own store, also at T0.
 *
 * Scorecard: every docs/BENCHMARK.md criterion has tests named
 * "criterion N <verdict>: …", where the verdict is `met`, `partial` or
 * `out of scope`. `npm run scorecard` counts a criterion as met only when its
 * tests are all `met` and all passed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ToolContext,
  composeResponse,
  gatherEvidence,
  tools,
  validateResponse,
} from "@harborline/agent-tools";
import {
  type CanonicalEvent,
  type Connector,
  type LonLat,
  type Resource,
  eventMaxAge,
  isStale,
  resourceMaxAge,
} from "@harborline/event-schema";
import {
  getSourceHealth,
  resetScheduler,
  startScheduler,
} from "../../services/api/src/scheduler.js";
import {
  DEMO_EVENT_IDS,
  DEMO_RESOURCE_IDS,
  USER_LAT,
  USER_LON,
  findEvent,
  findResource,
  seedScenario,
} from "./fixtures.js";

const SHELTER_QUESTION = "Where is the nearest open shelter?";
const USER: LonLat = [USER_LON, USER_LAT];

/** T0 — first 911 report reaches the CAL FIRE ECC (06:25 PST, DA report). */
const T0 = new Date("2018-11-08T14:25:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

/** The one replay store: seeded at T0, queried at later checkpoints. */
const replay = seedScenario(T0);
const checkpoint = (minutes: number): ToolContext => ({ store: replay.store, now: at(minutes) });

function shelterTemplate(): Resource {
  return findResource(replay.fixtures, DEMO_RESOURCE_IDS.neighborhood);
}

afterEach(() => {
  vi.useRealTimers();
  resetScheduler();
});

describe("real2sim: T0+0 — first report (06:25). Records precede orders.", () => {
  // Camp Fire: the fire was real at 06:25; the first evacuation order came at
  // 07:23 and Paradise's zone orders at 07:46+ — after the fire had arrived
  // (07:44). Advice must flow from observations, never be gated on "an order
  // exists for your zone".
  const ctx = checkpoint(0);

  it("surfaces the active fire for the user with no evacuation_order on file", () => {
    const types = tools.get_active_events(ctx, { lat: USER_LAT, lon: USER_LON, radius_m: 8_000 })
      .events.map((e) => e.event_type);
    expect(types).toContain("fire");
    expect(types).not.toContain("evacuation_order");
  });

  it("criterion 4 met: with no order on file, 'Should I stay home?' relays the leave-now instruction and the act-now note", () => {
    const question = "Should I stay home?";
    const evidence = gatherEvidence(ctx, question, USER);
    expect(evidence.events.some((e) => e.event_type === "evacuation_order")).toBe(false);
    const response = composeResponse(question, evidence, ctx.now);
    expect(response.answer_markdown).toMatch(/do not wait for a mandatory order/i);
    expect(response.answer_markdown).toContain("rather than waiting for a zone-by-zone instruction");
    expect(response.answer_markdown).not.toMatch(/stay (home|put|where you are)/i);
    expect(validateResponse(response, evidence, ctx.now).violations).toEqual([]);
  });

  it("criterion 12 met: every surfaced event carries provider and age, and the disputed closure keeps its official status", () => {
    const result = tools.get_active_events(ctx, { lat: USER_LAT, lon: USER_LON, radius_m: 8_000 });
    for (const event of result.events) {
      expect(event.age_label).toBeTruthy();
      expect(event.providers.length).toBeGreaterThan(0);
    }
    const compared = tools.compare_source_records(ctx, { event_id: DEMO_EVENT_IDS.closureOleander })!;
    expect(compared.disagreement).toBe(true);
    expect(compared.tiers).toEqual(expect.arrayContaining(["B", "E"]));
    const closure = result.events.find((e) => e.event_id === DEMO_EVENT_IDS.closureOleander)!;
    expect(closure.status).toBe("active");
    expect(closure.contradiction_note).toBeTruthy();
  });

  it("criterion 6 met: an immediate severe hazard appends the act-now note", () => {
    const evidence = gatherEvidence(ctx, SHELTER_QUESTION, USER);
    const response = composeResponse(SHELTER_QUESTION, evidence, ctx.now);
    expect(response.answer_markdown).toContain("marked immediate");
    expect(response.answer_markdown).toContain("rather than waiting for a zone-by-zone instruction");
    expect(validateResponse(response, evidence, ctx.now).violations).toEqual([]);
  });
});

describe("real2sim: T0+80m — fire inside town (07:45). The Feather River rule.", () => {
  // Feather River Hospital evacuated ~67-80 patients mid-procedure while still
  // nominally "a hospital". The fire record seeded at T0 is now 84 min old,
  // past its 1 h freshness budget: the facility must still be excluded.
  const ctx = checkpoint(80);
  const { store } = seedScenario(T0);
  const hospital: Resource = {
    ...shelterTemplate(),
    resource_id: "sim-feather-river-hospital",
    resource_type: "hospital",
    name: "Ridge Hospital (in fire zone)",
    location: { type: "Point", coordinates: [-121.834, 39.745] }, // inside polygon
    last_verified_at: ctx.now.toISOString(), // perfectly fresh and still wrong to send anyone there
  };
  store.upsertResource(hospital);
  const local: ToolContext = { store, now: ctx.now };

  it("ages the fire record past its freshness budget between T0 and T0+80m", () => {
    expect(tools.get_event_details(checkpoint(0), { event_id: DEMO_EVENT_IDS.fire })!.event.stale).toBe(false);
    expect(tools.get_event_details(ctx, { event_id: DEMO_EVENT_IDS.fire })!.event.stale).toBe(true);
  });

  it("criterion 8 met: rejects the fresh, open hospital inside the now-stale fire as inside_hazard_zone", () => {
    const result = tools.get_nearby_resources(local, { lat: USER_LAT, lon: USER_LON, resource_type: "hospital" });
    const rejected = result.rejected.find((r) => r.resource.resource_id === hospital.resource_id);
    expect(rejected?.rejected_reason).toBe("inside_hazard_zone");
    expect(result.recommendable.map((r) => r.resource_id)).not.toContain(hospital.resource_id);
  });
});

describe("real2sim: T0+2h35m — arteries closing (09:00, Pentz closed).", () => {
  // NIST TN 2252: every egress artery closed at least once; >=2 of 4 closed
  // simultaneously for 68% of 08:00-14:15. Routes crossing a reported closure
  // or a severe fire area are eliminated, not discounted, and survivors are
  // risk-ranked — never called "safe".
  const ctx = checkpoint(155);
  const routes = tools.calculate_routes(ctx, {
    from_lat: USER_LAT,
    from_lon: USER_LON,
    to_resource_id: DEMO_RESOURCE_IDS.neighborhood,
  });

  it("eliminates closure-crossing candidates outright", () => {
    const eliminated = routes.candidates.filter((c) => c.eliminated);
    expect(eliminated.length).toBeGreaterThan(0);
    for (const candidate of eliminated) {
      expect(["closure_intersection", "evacuation_zone", "hazard_zone", "no_path"]).toContain(
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

  it("criterion 1 partial: a route to a shelter beyond the severe fire is eliminated, a lower-severity crossing is kept but disclosed", () => {
    const { store } = seedScenario(T0);
    const local: ToolContext = { store, now: ctx.now };
    store.upsertResource({
      ...shelterTemplate(),
      resource_id: "sim-east-shelter",
      name: "East Side Shelter",
      location: { type: "Point", coordinates: [-121.8305, 39.7415] }, // east of the fire
      last_verified_at: ctx.now.toISOString(),
    });
    const blocked = tools.calculate_routes(local, { from_lat: USER_LAT, from_lon: USER_LON, to_resource_id: "sim-east-shelter" });
    expect(blocked.recommendation).toBeNull();
    expect(blocked.candidates.some((c) => c.rejected_reason === "hazard_zone")).toBe(true);

    // Partial, not met: a moderate fire area does not eliminate. The kept
    // route is disclosed, but it still goes through the hazard.
    const fire = findEvent(replay.fixtures, DEMO_EVENT_IDS.fire);
    store.upsertEvent({ ...fire, severity: "moderate", last_verified_at: ctx.now.toISOString() }, []);
    const kept = tools.calculate_routes(local, { from_lat: USER_LAT, from_lon: USER_LON, to_resource_id: "sim-east-shelter" });
    expect(kept.recommendation!.summary).toMatch(/passes through or near \d+ reported hazard area/);
  });
});

describe("real2sim: T0+5h — road status is perishable (criterion 2)", () => {
  // Skyway's status changed repeatedly through the morning. At T0+5h the
  // closure records seeded at T0 are past their 4 h budget. A record that
  // would permit an action (a shelter's "open") expires from the
  // recommendation basis; a record that forbids one (a closure) fails closed
  // and is shown with its age and a stale flag, never as current.
  const ctx = checkpoint(300);

  it("gives a road_closure record a 4 h freshness budget", () => {
    const maxAge = eventMaxAge("road_closure");
    expect(maxAge).toBe(4 * 3600);
    expect(isStale(T0.toISOString(), maxAge, at(3 * 60))).toBe(false);
    expect(isStale(T0.toISOString(), maxAge, at(5 * 60))).toBe(true);
  });

  it("expires a shelter status after 24 h (the Bidwell rule)", () => {
    const maxAge = resourceMaxAge("shelter");
    expect(isStale(T0.toISOString(), maxAge, at(23 * 60))).toBe(false);
    expect(isStale(T0.toISOString(), maxAge, at(25 * 60))).toBe(true);
  });

  it("criterion 2 met: stale closures are flagged with their age and still block, and a day-old shelter status is rejected", () => {
    const closure = tools.get_event_details(ctx, { event_id: DEMO_EVENT_IDS.closureOleander })!;
    expect(tools.get_event_details(checkpoint(155), { event_id: DEMO_EVENT_IDS.closureOleander })!.event.stale).toBe(false);
    expect(closure.event.stale).toBe(true);
    expect(closure.event.age_label).toMatch(/h ago/);

    const routes = tools.calculate_routes(ctx, { from_lat: USER_LAT, from_lon: USER_LON, to_resource_id: DEMO_RESOURCE_IDS.neighborhood });
    expect(routes.candidates.some((c) => c.intersecting_event_ids.includes(DEMO_EVENT_IDS.closureOleander) && c.eliminated)).toBe(true);

    const evidence = gatherEvidence(ctx, "Which roads should I avoid?", USER);
    const response = composeResponse("Which roads should I avoid?", evidence, ctx.now);
    expect(response.answer_markdown).toMatch(/Oleander Ave closed[^\n]*verified \d+ h ago/);
    expect(validateResponse(response, evidence, ctx.now).violations).toEqual([]);

    const shelters = tools.get_nearby_resources(ctx, { lat: USER_LAT, lon: USER_LON, resource_type: "shelter" });
    expect(shelters.rejected.find((r) => r.resource.resource_id === DEMO_RESOURCE_IDS.bidwell)?.rejected_reason).toBe("stale_status");
  });
});

describe("real2sim: every artery cut → refuge-in-place guidance (criterion 3)", () => {
  // NIST TN 2252: all five egress arteries out of Paradise closed at least
  // once; 31 improvised temporary refuge areas held 1,200+ people whose routes
  // were gone. When every candidate route is eliminated, the answer must say
  // so and give refuge direction — not go silent.
  const { store, fixtures } = seedScenario(T0);
  const ctx: ToolContext = { store, now: at(155) };
  const template = fixtures.events.find((e) => e.event_type === "road_closure")!;
  const barrier: CanonicalEvent = {
    ...template,
    event_id: "sim-barrier-all-arteries",
    headline: "All northbound arteries closed by fire",
    last_verified_at: at(150).toISOString(),
    geometry: { type: "LineString", coordinates: [[-121.9, 39.746], [-121.78, 39.746]] },
  };
  store.upsertEvent(barrier, []);

  it("eliminates every candidate and recommends nothing", () => {
    const routes = tools.calculate_routes(ctx, { from_lat: USER_LAT, from_lon: USER_LON, to_resource_id: DEMO_RESOURCE_IDS.neighborhood });
    expect(routes.candidates.length).toBeGreaterThan(0);
    expect(routes.candidates.every((c) => c.eliminated)).toBe(true);
    expect(routes.recommendation).toBeNull();
  });

  it("criterion 3 met: composes explicit no-route + refuge-in-place guidance that passes the validator", () => {
    const evidence = gatherEvidence(ctx, SHELTER_QUESTION, USER);
    const response = composeResponse(SHELTER_QUESTION, evidence, ctx.now);
    expect(response.answer_markdown).toContain("No route is currently verified as passable");
    expect(response.answer_markdown).toContain("cleared");
    expect(response.recommended_action).not.toMatch(/head for/i);
    expect(validateResponse(response, evidence, ctx.now).violations).toEqual([]);
  });
});

describe("real2sim: channel failure is visible (criterion 5)", () => {
  // The county's WEA activation failed silently. A source that fetches fine
  // but contributes zero records, or stops fetching, must show up in health.
  it("criterion 5 met: per-source health reports a green-but-empty fetch and a failing one", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(at(0));
    const empty: Connector = {
      id: "sim-empty", label: "Empty feed", source_tier: "A", expected_refresh_seconds: 60,
      async fetch(now) { return { ok: true, retrieved_at: now.toISOString(), events: [], resources: [], source_records: [] }; },
    };
    const failing: Connector = {
      id: "sim-failing", label: "Failing feed", source_tier: "A", expected_refresh_seconds: 60,
      async fetch(now) { return { ok: false, retrieved_at: now.toISOString(), error: "HTTP 503" }; },
    };
    await startScheduler({ store: seedScenario(T0).store, demoMode: false, connectors: [empty, failing] });
    await vi.advanceTimersByTimeAsync(10);
    const health = new Map(getSourceHealth().map((h) => [h.id, h]));
    expect(health.get("sim-empty")).toMatchObject({ healthy: true, last_success_records: { events: 0, resources: 0 } });
    expect(health.get("sim-failing")).toMatchObject({ healthy: false, consecutive_failures: 1, last_success_at: null });
  });
});

describe("real2sim: shelter capacity, health advisories and the named plan B (criteria 7 + 11)", () => {
  // Norovirus ran through four official Camp Fire shelters (140+ symptomatic)
  // while every one stayed "open"; Oroville Nazarene reached 352 occupants and
  // overflow arrivals ended up in the Walmart parking lot.
  const { store } = seedScenario(T0);
  const ctx: ToolContext = { store, now: at(600) };
  store.upsertResource({
    ...shelterTemplate(),
    resource_id: "sim-shelter-advisory",
    name: "Downtown Gym Shelter",
    location: { type: "Point", coordinates: [USER_LON, USER_LAT + 0.0015] },
    health_advisory: "Norovirus outbreak reported by county public health",
    last_verified_at: at(590).toISOString(),
  });
  const evidence = gatherEvidence(ctx, SHELTER_QUESTION, USER);
  const response = composeResponse(SHELTER_QUESTION, evidence, ctx.now);

  it("criterion 7 met: a full shelter is rejected with its numbers, and a health advisory is surfaced on the open one", () => {
    const full = tools.get_nearby_resources(ctx, { lat: USER_LAT, lon: USER_LON, resource_type: "shelter" })
      .rejected.find((r) => r.resource.resource_id === DEMO_RESOURCE_IDS.chico);
    expect(full?.rejected_reason).toBe("full");
    expect(full!.resource.capacity_available).toBe(0);
    expect(response.answer_markdown).toContain("Downtown Gym Shelter");
    expect(response.answer_markdown).toContain("Health advisory: Norovirus outbreak reported by county public health");
    expect(validateResponse(response, evidence, ctx.now).violations).toEqual([]);
  });

  it("criterion 11 partial: names the plan-B destination; multi-city load balancing is not modelled", () => {
    expect(response.answer_markdown).toContain("If it is full when you arrive, next option: Neighborhood Church");
  });
});

describe("real2sim: accessibility-aware ranking (criterion 10)", () => {
  // Camp Fire victims skewed elderly and mobility-limited (average age ~72).
  const { store } = seedScenario(T0);
  const ctx: ToolContext = { store, now: at(30) };
  store.upsertResource({
    ...shelterTemplate(),
    resource_id: "sim-shelter-no-access",
    name: "Corner Store Annex",
    location: { type: "Point", coordinates: [USER_LON, USER_LAT + 0.001] },
    accessibility_features: [],
    last_verified_at: at(25).toISOString(),
  });

  it("criterion 10 met: prefers the accessible shelter when the question asks for it", () => {
    const question = "Where is the nearest wheelchair accessible shelter?";
    const evidence = gatherEvidence(ctx, question, USER);
    const response = composeResponse(question, evidence, ctx.now);
    expect(response.answer_markdown).toContain("The nearest open shelter is **Neighborhood Church**");
    expect(response.answer_markdown).toContain("Accessibility: wheelchair_accessible");
    expect(validateResponse(response, evidence, ctx.now).violations).toEqual([]);
  });

  it("keeps plain distance order when accessibility is not asked about", () => {
    const response = composeResponse(SHELTER_QUESTION, gatherEvidence(ctx, SHELTER_QUESTION, USER), ctx.now);
    expect(response.answer_markdown).toContain("The nearest open shelter is **Corner Store Annex**");
  });
});

describe("real2sim: contraflow (criterion 9)", () => {
  // Traffic command, not civilian information. Harborline has no capability
  // to assert here, so the criterion is recorded as a skipped test.
  it.skip("criterion 9 out of scope: proactive capacity actions such as contraflow", () => {});
});
