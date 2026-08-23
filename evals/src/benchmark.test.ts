/**
 * Camp Fire benchmark invariants (docs/BENCHMARK.md).
 *
 * Each test pins a behavior to a documented failure of the real 2018 Camp Fire
 * response. The sharpest: Feather River Hospital was still "a hospital" on
 * paper while its staff carried patients out through the fire — a facility
 * inside an active hazard footprint must never be recommended, whatever its
 * own status record says (benchmark criterion 8).
 */
import { describe, expect, it } from "vitest";
import { tools } from "@harborline/agent-tools";
import type { Resource } from "@harborline/event-schema";
import {
  DEMO_RESOURCE_IDS,
  NOW,
  USER_LAT,
  USER_LON,
  findResource,
  seedScenario,
} from "./fixtures.js";

describe("resource inside an active hazard zone (Feather River rule)", () => {
  const { store, ctx, fixtures } = seedScenario();

  // A fresh, open shelter placed inside the seeded severe fire polygon
  // (lon -121.8365..-121.832, lat 39.738..39.755).
  const template = findResource(fixtures, DEMO_RESOURCE_IDS.neighborhood);
  const inHazard: Resource = {
    ...template,
    resource_id: "test-shelter-inside-fire-zone",
    name: "Inside-Zone Shelter",
    location: { type: "Point", coordinates: [-121.834, 39.745] },
    operational_status: "open",
    last_verified_at: NOW.toISOString(),
  };
  store.upsertResource(inHazard);

  const result = tools.get_nearby_resources(ctx, {
    lat: USER_LAT,
    lon: USER_LON,
    resource_type: "shelter",
  });

  it("rejects the fresh, open, in-zone shelter with inside_hazard_zone", () => {
    const rejected = result.rejected.find(
      (r) => r.resource.resource_id === inHazard.resource_id,
    );
    expect(rejected).toBeDefined();
    expect(rejected!.rejected_reason).toBe("inside_hazard_zone");
  });

  it("never lists the in-zone shelter as recommendable", () => {
    expect(
      result.recommendable.map((r) => r.resource_id),
    ).not.toContain(inHazard.resource_id);
  });

  it("still recommends the safe open shelter outside the zone", () => {
    expect(result.recommendable.map((r) => r.resource_id)).toContain(
      DEMO_RESOURCE_IDS.neighborhood,
    );
  });

  it("hazard containment outranks the resource's own open status", () => {
    const rejected = result.rejected.find(
      (r) => r.resource.resource_id === inHazard.resource_id,
    );
    expect(rejected!.resource.operational_status).toBe("open");
  });
});
