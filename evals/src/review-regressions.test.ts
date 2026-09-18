import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateRoutes, composeResponse, gatherEvidence, tools } from "@harborline/agent-tools";
import type { RoadGraph } from "@harborline/agent-tools";
import type { CanonicalEvent, LonLat } from "@harborline/event-schema";
import { assistantRoutes } from "../../services/api/src/routes/assistant.js";
import { routesRoutes } from "../../services/api/src/routes/routes.js";
import { store as apiStore } from "../../services/api/src/state.js";
import { DEMO_RESOURCE_IDS, DEMO_USER_LOCATION, NOW, USER_LAT, USER_LON, evacuationOrderEvent, findResource, seedScenario } from "./fixtures.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function accessibleScenario() {
  const scenario = seedScenario();
  const template = findResource(scenario.fixtures, DEMO_RESOURCE_IDS.neighborhood);
  scenario.store.upsertResource({ ...template, resource_id: "closer-annex", name: "Corner Store Annex", location: { type: "Point", coordinates: [USER_LON, USER_LAT + 0.001] }, accessibility_features: [] });
  return scenario;
}

describe("review: selected shelter and route agree", () => {
  it("routes to the accessible destination before composing", () => {
    const { ctx } = accessibleScenario();
    const question = "Where is the nearest wheelchair accessible shelter?";
    const evidence = gatherEvidence(ctx, question, DEMO_USER_LOCATION);
    expect(evidence.resources![0]!.resource_id).toBe(DEMO_RESOURCE_IDS.neighborhood);
    expect(evidence.route!.recommendation!.destination_resource_id).toBe(DEMO_RESOURCE_IDS.neighborhood);
    const chosen = evidence.route!.candidates.find(c => c.route_id === evidence.route!.recommendation!.route_id)!;
    expect(chosen.geometry.coordinates.at(-1)).toEqual(evidence.resources![0]!.location.coordinates);
    const response = composeResponse(question, evidence, NOW);
    expect(response.recommended_action).toContain("Neighborhood Church");
    expect(response.answer_markdown).toContain("available to Neighborhood Church");
  });

  it("applies the same destination choice through the actual assistant endpoint", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", ""); vi.stubEnv("OPENAI_API_KEY", "");
    const { store } = accessibleScenario();
    for (const resource of store.allResources()) apiStore.upsertResource(resource);
    const result = await assistantRoutes.request("/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "Where is the nearest wheelchair accessible shelter?", lat: USER_LAT, lon: USER_LON }) });
    expect(result.status).toBe(200);
    const response = await result.json();
    expect(response.answer_markdown).toContain("available to Neighborhood Church");
    expect(response.recommended_action).toContain("Neighborhood Church");
  });
});

describe("review: unavailable routes never produce departure advice", () => {
  it("does not say Head for when all routes were eliminated", () => {
    const { ctx } = seedScenario();
    const evidence = gatherEvidence(ctx, "nearest shelter", DEMO_USER_LOCATION);
    evidence.route!.recommendation = null;
    evidence.route!.candidates = evidence.route!.candidates.map(c => ({ ...c, eliminated: true, rejected_reason: "closure_intersection" as const }));
    const response = composeResponse("nearest shelter", evidence, NOW);
    expect(response.answer_markdown).toContain("No route is currently verified as passable");
    expect(response.recommended_action).not.toMatch(/head for/i);
    expect(response.recommended_action).toMatch(/no route|not verified/i);
  });

  it.each(["no_path", "missing"])("does not infer blocked roads from %s routing", (state) => {
    const { ctx } = seedScenario();
    const evidence = gatherEvidence(ctx, "nearest shelter", DEMO_USER_LOCATION);
    if (state === "missing") evidence.route = undefined;
    else {
      evidence.route!.recommendation = null;
      evidence.route!.candidates = evidence.route!.candidates.map(c => ({ ...c, eliminated: true, rejected_reason: "no_path" as const }));
    }
    const response = composeResponse("nearest shelter", evidence, NOW);
    expect(response.recommended_action).not.toMatch(/head for/i);
    expect(response.recommended_action).toMatch(/not verified/i);
    expect(response.answer_markdown).not.toContain("non-vegetated open area");
  });
});

describe("review: direct routing obeys resource eligibility", () => {
  it.each(["closed", "full", "unknown", "stale", "hazard"])("does not route to a %s destination", (state) => {
    const { store, ctx, fixtures } = seedScenario();
    const destination = { ...findResource(fixtures, DEMO_RESOURCE_IDS.neighborhood) };
    if (state === "stale") destination.last_verified_at = new Date(NOW.getTime() - 25 * 3600_000).toISOString();
    else if (state === "hazard") destination.location = { type: "Point", coordinates: [-121.834, 39.745] };
    else destination.operational_status = state as "closed" | "full" | "unknown";
    store.upsertResource(destination);
    const result = tools.calculate_routes(ctx, { from_lat: USER_LAT, from_lon: USER_LON, to_resource_id: destination.resource_id });
    expect(result.recommendation).toBeNull();
  });

  it("keeps a fresh open destination routable (positive control)", () => {
    const { ctx } = seedScenario();
    expect(tools.calculate_routes(ctx, { from_lat: USER_LAT, from_lon: USER_LON, to_resource_id: DEMO_RESOURCE_IDS.neighborhood }).recommendation).not.toBeNull();
  });

  it("returns a destination-specific rejection from the route API", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const { fixtures } = seedScenario();
    const destination = { ...findResource(fixtures, DEMO_RESOURCE_IDS.neighborhood), resource_id: "closed-api-destination", operational_status: "closed" as const };
    apiStore.upsertResource(destination);
    const result = await routesRoutes.request(`/?from_lat=${USER_LAT}&from_lon=${USER_LON}&to_resource_id=${destination.resource_id}`);
    expect(result.status).toBe(422);
    expect(await result.json()).toMatchObject({ error: "destination_unavailable", rejected_reason: "closed" });
  });
});

describe("review: approach legs receive hazard checks", () => {
  const graph: RoadGraph = {
    nodes: [{ id: "a", name: "A", coord: [0, 0] }, { id: "b", name: "B", coord: [0.02, 0] }],
    edges: [{ from: "a", to: "b", geometry: [[0, 0], [0.02, 0]], name: "Test Road" }],
  };
  const from: LonLat = [-0.005, 0];
  const to: LonLat = [0.025, 0];
  it.each([-0.005, -0.0025, 0.0225, 0.025])("rejects a closure on the approach at longitude %s", (lon) => {
    const closure: CanonicalEvent = { ...evacuationOrderEvent(), event_type: "road_closure", geometry: { type: "LineString", coordinates: [[lon, -0.001], [lon, 0.001]] } };
    const result = calculateRoutes({ from, to, events: [closure], now: NOW }, graph);
    expect(result.best).toBeNull();
    expect(result.candidates[0]!.rejected_reason).toBe("closure_intersection");
    expect(result.candidates[0]!.intersecting_event_ids).toContain(closure.event_id);
  });
  it("allows the same approach without a closure", () => {
    expect(calculateRoutes({ from, to, events: [], now: NOW }, graph).best).not.toBeNull();
  });
});


describe("review: shared recent-update window", () => {
  it("excludes old records and their sources without widening an empty window", () => {
    const { ctx } = seedScenario();
    const later = { ...ctx, now: new Date(NOW.getTime() + 2 * 3600_000) };
    const evidence = gatherEvidence(later, "What changed in the last hour?", DEMO_USER_LOCATION);
    expect(evidence.events).toEqual([]);
    expect(evidence.source_records).toEqual([]);
    expect(gatherEvidence(ctx, "What changed in the last hour?", DEMO_USER_LOCATION).events.length).toBeGreaterThan(0);
  });
});

it("preserves stale-event metadata for the LLM after evidence consolidation", () => {
  const { ctx } = seedScenario();
  const evidence = gatherEvidence({ ...ctx, now: new Date(NOW.getTime() + 2 * 3600_000) }, "What is happening?", DEMO_USER_LOCATION);
  expect(evidence.events.find(event => event.event_type === "fire")).toMatchObject({
    stale: true,
    max_age_seconds: 3600,
    age_seconds: expect.any(Number),
    age_label: expect.any(String),
    providers: expect.arrayContaining(["CAL FIRE"]),
  });
});
