/**
 * Freshness policy (BUILD_GUIDE §7).
 *
 * A record past its freshness budget is still shown, but it can never be the
 * basis of a recommendation. These tests pin the boundary and the consequence.
 */
import { describe, expect, it } from "vitest";
import { tools } from "@harborline/agent-tools";
import { FRESHNESS_POLICY, isStale, resourceMaxAge } from "@harborline/event-schema";
import {
  DEMO_RESOURCE_IDS,
  NOW,
  USER_LAT,
  USER_LON,
  seedScenario,
} from "./fixtures.js";

const SHELTER_MAX_AGE = resourceMaxAge("shelter");

function agedIso(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

describe("isStale — shelter 24 h policy boundary", () => {
  it("uses a 24 h budget for shelters", () => {
    expect(SHELTER_MAX_AGE).toBe(24 * 3600);
    expect(FRESHNESS_POLICY.resources.shelter).toBe(24 * 3600);
  });

  it("treats a 23 h 59 m old record as fresh", () => {
    expect(isStale(agedIso(23 * 60 + 59), SHELTER_MAX_AGE, NOW)).toBe(false);
  });

  it("treats a 24 h 01 m old record as stale", () => {
    expect(isStale(agedIso(24 * 60 + 1), SHELTER_MAX_AGE, NOW)).toBe(true);
  });

  it("treats exactly 24 h as fresh (the budget is inclusive)", () => {
    expect(isStale(agedIso(24 * 60), SHELTER_MAX_AGE, NOW)).toBe(false);
  });

  it("treats the 26 h demo record as stale", () => {
    expect(isStale(agedIso(26 * 60), SHELTER_MAX_AGE, NOW)).toBe(true);
  });
});

describe("get_nearby_resources — recommendation gate", () => {
  const { ctx } = seedScenario();
  const result = tools.get_nearby_resources(ctx, {
    lat: USER_LAT,
    lon: USER_LON,
    resource_type: "shelter",
  });

  it("recommends Neighborhood Church first", () => {
    expect(result.recommendable.map((r) => r.name)).toEqual(["Neighborhood Church"]);
    expect(result.recommendable[0]!.resource_id).toBe(DEMO_RESOURCE_IDS.neighborhood);
    expect(result.recommendable[0]!.operational_status).toBe("open");
    expect(result.recommendable[0]!.distance_m).toBeGreaterThan(0);
  });

  it("rejects the 26 h stale shelter with rejected_reason stale_status", () => {
    const bidwell = result.rejected.find(
      (r) => r.resource.resource_id === DEMO_RESOURCE_IDS.bidwell,
    );
    expect(bidwell).toBeDefined();
    expect(bidwell!.rejected_reason).toBe("stale_status");
    // Its stored status still reads "open" — freshness, not status, rejected it.
    expect(bidwell!.resource.operational_status).toBe("open");
  });

  it("rejects the at-capacity shelter with rejected_reason full", () => {
    const chico = result.rejected.find(
      (r) => r.resource.resource_id === DEMO_RESOURCE_IDS.chico,
    );
    expect(chico).toBeDefined();
    expect(chico!.rejected_reason).toBe("full");
    expect(chico!.resource.capacity_available).toBe(0);
  });

  it("accounts for every seeded shelter exactly once", () => {
    const ids = [
      ...result.recommendable.map((r) => r.resource_id),
      ...result.rejected.map((r) => r.resource.resource_id),
    ].sort();
    expect(ids).toEqual(
      [
        DEMO_RESOURCE_IDS.neighborhood,
        DEMO_RESOURCE_IDS.bidwell,
        DEMO_RESOURCE_IDS.chico,
      ].sort(),
    );
  });
});

describe("get_resource_status — staleness is reported, not hidden", () => {
  const { ctx } = seedScenario();

  it("reports the stale shelter as stale with its age", () => {
    const status = tools.get_resource_status(ctx, {
      resource_id: DEMO_RESOURCE_IDS.bidwell,
    });
    expect(status).not.toBeNull();
    expect(status!.stale).toBe(true);
    expect(status!.age_seconds).toBeGreaterThan(SHELTER_MAX_AGE);
    expect(status!.max_age_seconds).toBe(SHELTER_MAX_AGE);
  });

  it("reports the recently verified shelter as fresh", () => {
    const status = tools.get_resource_status(ctx, {
      resource_id: DEMO_RESOURCE_IDS.neighborhood,
    });
    expect(status!.stale).toBe(false);
    expect(status!.age_label).toBe("8 min ago");
  });
});

describe("fire feed budgets", () => {
  it("gives satellite detections 6 h and perimeters 24 h", () => {
    expect(FRESHNESS_POLICY.events.fire_detection).toBe(6 * 3600);
    expect(FRESHNESS_POLICY.events.fire_perimeter).toBe(24 * 3600);
  });

  it("keeps the official fire budget at 1 h (the replay's criterion 8 needs it)", () => {
    expect(FRESHNESS_POLICY.events.fire).toBe(3600);
  });

  it("treats a 5 h old detection as fresh and a 7 h old one as stale", () => {
    const budget = FRESHNESS_POLICY.events.fire_detection;
    expect(isStale(agedIso(5 * 60), budget, NOW)).toBe(false);
    expect(isStale(agedIso(7 * 60), budget, NOW)).toBe(true);
  });
});
