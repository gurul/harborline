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
import { tools } from "@harborline/agent-tools";
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
