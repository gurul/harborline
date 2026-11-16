/**
 * Assistant support for fire and air questions, access needs, and a route to
 * a caller-chosen shelter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AIR_ACTION,
  FIRE_LIMITS_LINE,
  composeResponse,
  gatherEvidence,
  planQuery,
  validateResponse,
} from "@harborline/agent-tools";
import { makeEvent, makeSourceRecord } from "@harborline/connectors";
import type { LonLat, Observation, Resource } from "@harborline/event-schema";
import { assistantRoutes } from "../../services/api/src/routes/assistant.js";
import { store as apiStore } from "../../services/api/src/state.js";
import {
  DEMO_RESOURCE_IDS,
  DEMO_USER_LOCATION,
  NOW,
  USER_LAT,
  USER_LON,
  findResource,
  seedScenario,
} from "./fixtures.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function airReading(aqi: number, category: "Good" | "Unhealthy for Sensitive Groups", ageMin: number): Observation {
  return {
    kind: "air_quality",
    observation_id: "airnow:ca|chico",
    name: "Chico, CA",
    location: { type: "Point", coordinates: [-121.8422, 39.7575] },
    observed_at: minutesAgo(ageMin),
    last_verified_at: minutesAgo(ageMin),
    provider: "AirNow (EPA and partner agencies)",
    provider_tier: "B",
    source_url: "https://www.airnow.gov/",
    aqi,
    category,
    pollutant: "PM2.5",
  };
}

function addDetection(store: ReturnType<typeof seedScenario>["store"], id: string, at: LonLat) {
  const d = 0.002;
  const [x, y] = at;
  const verified = minutesAgo(120);
  store.upsertEvent(makeEvent({
    event_id: id,
    event_type: "fire_detection",
    headline: `Satellite heat detection ${id}`,
    description: "test",
    severity: "moderate",
    urgency: "unknown",
    certainty: "likely",
    geometry: { type: "MultiPolygon", coordinates: [[[[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d], [x - d, y - d]]]] },
    starts_at: verified,
    ends_at: new Date(new Date(verified).getTime() + 24 * 3600_000).toISOString(),
    last_verified_at: verified,
    best_tier: "C",
  }, NOW), [makeSourceRecord({
    source_record_id: `rec-${id}`,
    event_id: id,
    provider: "NASA FIRMS (VIIRS)",
    provider_record_id: null,
    provider_tier: "C",
    source_url: "https://firms.modaps.eosdis.nasa.gov/active_fire/",
    published_at: verified,
    retrieved_at: NOW.toISOString(),
    hash_input: id,
  })]);
}

describe("question types", () => {
  it.each([
    ["Is there a fire near me?", "fire_nearby"],
    ["Any wildfires burning nearby?", "fire_nearby"],
    ["Is it smoky out there?", "fire_nearby"],
    ["How is the air quality?", "air_quality"],
    ["What is the AQI?", "air_quality"],
    ["Is the smoke making the air bad to breathe?", "air_quality"],
  ])("%s -> %s", (question, intent) => {
    expect(planQuery(question).intent).toBe(intent);
  });

  it.each([
    ["Should I stay home?", "general"],
    ["What is the evacuation route?", "nearest_shelter"],
    ["Is there fire on my route?", "roads_to_avoid"],
    ["There is a fire, should I evacuate?", "nearest_shelter"],
    ["Where is the nearest open shelter?", "nearest_shelter"],
  ])("regression: %s keeps %s", (question, intent) => {
    expect(planQuery(question).intent).toBe(intent);
  });
});

describe("fire_nearby answers", () => {
  it("lists official records first, summarises detections in one line, ends with the limits, and passes the validator", () => {
    const { ctx, store } = seedScenario();
    addDetection(store, "det-a", [-121.80, 39.76]);
    addDetection(store, "det-b", [-121.79, 39.77]);
    addDetection(store, "det-c", [-121.78, 39.70]);
    const evidence = gatherEvidence(ctx, "Is there a fire near me?", DEMO_USER_LOCATION, { fire_feeds_healthy: true });
    expect(evidence.intent).toBe("fire_nearby");
    const response = composeResponse("Is there a fire near me?", evidence, NOW);
    const lines = response.answer_markdown.split("\n");
    expect(lines[0]).toMatch(/^Official fire and evacuation records/);
    expect(response.answer_markdown).toMatch(/3 satellite heat detection clusters within 25\.0 km: nearest [\d.]+ km, newest detected 2 h ago .*Unconfirmed by a fire agency/);
    // The limits close the fire section; the immediate-alert note may follow it.
    const limitsAt = lines.indexOf(FIRE_LIMITS_LINE);
    expect(limitsAt).toBeGreaterThan(lines.findIndex((l) => l.includes("satellite heat detection clusters")));
    // One source for all three detection clusters.
    expect(response.sources.filter((s) => s.provider === "NASA FIRMS (VIIRS)")).toHaveLength(1);
    expect(validateResponse(response, evidence, NOW)).toEqual({ ok: true, violations: [] });
  });

  it("with a healthy feed and nothing near, says so without claiming there is no fire", () => {
    const { ctx } = seedScenario();
    const far: LonLat = [-118.0, 34.0];
    const evidence = gatherEvidence(ctx, "Is there a fire near me?", far, { fire_feeds_healthy: true });
    const response = composeResponse("Is there a fire near me?", evidence, NOW);
    expect(response.answer_markdown).toMatch(/No verified reports of a satellite heat detection within 25\.0 km/);
    expect(response.answer_markdown).not.toMatch(/there is no fire/i);
    expect(validateResponse(response, evidence, NOW).ok).toBe(true);
  });

  it("says the satellite feed is unavailable when no fire feed is healthy", () => {
    const { ctx } = seedScenario();
    const evidence = gatherEvidence(ctx, "Is there a fire near me?", DEMO_USER_LOCATION);
    const response = composeResponse("Is there a fire near me?", evidence, NOW);
    expect(response.answer_markdown).toMatch(/Satellite fire data is not available right now/);
    expect(validateResponse(response, evidence, NOW).ok).toBe(true);
  });
});

describe("air_quality answers", () => {
  it("states the AQI, category, pollutant, age and provider, with the EPA action", () => {
    const { ctx, store } = seedScenario();
    store.upsertObservation(airReading(120, "Unhealthy for Sensitive Groups", 40));
    const evidence = gatherEvidence(ctx, "How is the air quality?", DEMO_USER_LOCATION);
    const response = composeResponse("How is the air quality?", evidence, NOW);
    expect(response.answer_markdown).toMatch(/AQI 120, Unhealthy for Sensitive Groups, main pollutant PM2\.5\. Reported 40 min ago by AirNow/);
    expect(response.recommended_action).toBe(AIR_ACTION["Unhealthy for Sensitive Groups"]);
    expect(response.sources.map((s) => s.provider)).toContain("AirNow (EPA and partner agencies)");
    expect(validateResponse(response, evidence, NOW).ok).toBe(true);
  });

  it("gives a stale reading's age and says there is no current reading", () => {
    const { ctx, store } = seedScenario();
    store.upsertObservation(airReading(39, "Good", 5 * 60));
    const evidence = gatherEvidence(ctx, "How is the air quality?", DEMO_USER_LOCATION);
    const response = composeResponse("How is the air quality?", evidence, NOW);
    expect(response.answer_markdown).toMatch(/from \*\*Chico, CA\*\*, 5 h ago .*There is no current reading/);
    expect(response.recommended_action).toMatch(/no current reading/);
    expect(validateResponse(response, evidence, NOW).ok).toBe(true);
  });

  it("says no verified reports when no reading is in range", () => {
    const { ctx } = seedScenario();
    const evidence = gatherEvidence(ctx, "How is the air quality?", DEMO_USER_LOCATION);
    const response = composeResponse("How is the air quality?", evidence, NOW);
    expect(response.answer_markdown).toMatch(/No verified reports of air quality/);
    expect(validateResponse(response, evidence, NOW).ok).toBe(true);
  });
});

function shelter(id: string, name: string, at: LonLat, pet_policy: string | null, accessibility: string[] = []): Resource {
  const template = findResource(seedScenario().fixtures, DEMO_RESOURCE_IDS.neighborhood);
  return { ...template, resource_id: id, name, location: { type: "Point", coordinates: at }, pet_policy, accessibility_features: accessibility };
}

function needsScenario() {
  const scenario = seedScenario();
  // Nearer than the church, but its record says no pets.
  scenario.store.upsertResource(shelter("test-annex", "Corner Annex", [USER_LON, USER_LAT + 0.001], "No pets"));
  scenario.store.upsertResource(shelter("test-west", "West Hall", [-121.846, 39.7465], null));
  return scenario;
}

describe("access needs and a chosen shelter", () => {
  const Q = "Where is the nearest open shelter?";

  it("ranks a pets-allowed shelter above a nearer no-pets one, and the route goes there", () => {
    const { ctx } = needsScenario();
    const plain = gatherEvidence(ctx, Q, DEMO_USER_LOCATION);
    expect(plain.resources![0]!.resource_id).toBe("test-annex");

    const evidence = gatherEvidence(ctx, Q, DEMO_USER_LOCATION, { access_needs: ["pets"] });
    expect(evidence.resources![0]!.resource_id).toBe(DEMO_RESOURCE_IDS.neighborhood);
    const response = composeResponse(Q, evidence, NOW);
    expect(response.destination_resource_id).toBe(DEMO_RESOURCE_IDS.neighborhood);
    expect(response.route!.recommendation.destination_resource_id).toBe(DEMO_RESOURCE_IDS.neighborhood);
    expect(response.route!.candidate.geometry.coordinates.at(-1)).toEqual(
      evidence.resources![0]!.location.coordinates,
    );
    expect(response.access_needs_applied).toEqual(["pets"]);
    expect(response.answer_markdown).toMatch(/Ranked for your access needs\. This shelter's record: pets: recorded\./);
    expect(validateResponse(response, evidence, NOW).ok).toBe(true);
  });

  it("routes to a recommendable shelter the caller chose, even when another is nearer", () => {
    const { ctx } = needsScenario();
    const evidence = gatherEvidence(ctx, "Take me there", DEMO_USER_LOCATION, { destination_resource_id: "test-west" });
    expect(evidence.intent).toBe("nearest_shelter");
    const response = composeResponse("Take me there", evidence, NOW);
    expect(response.destination_resource_id).toBe("test-west");
    expect(response.recommended_action).toContain("West Hall");
    if (response.route) expect(response.route.recommendation.destination_resource_id).toBe("test-west");
  });

  it("says a chosen shelter is excluded, and names and routes to the best other one", () => {
    const { ctx } = needsScenario();
    const evidence = gatherEvidence(ctx, Q, DEMO_USER_LOCATION, { destination_resource_id: DEMO_RESOURCE_IDS.bidwell });
    const response = composeResponse(Q, evidence, NOW);
    expect(response.answer_markdown).toMatch(/Bidwell Community Center, the shelter you selected, is excluded right now \(status not re-confirmed recently\)/);
    expect(response.destination_resource_id).toBe("test-annex");
    expect(validateResponse(response, evidence, NOW).ok).toBe(true);
  });

  it("carries both through the assistant endpoint and rejects an unknown need", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", ""); vi.stubEnv("OPENAI_API_KEY", "");
    const { store } = needsScenario();
    for (const resource of store.allResources()) apiStore.upsertResource(resource);
    for (const event of store.allEvents()) apiStore.upsertEvent(event, store.getEvent(event.event_id)!.source_records);

    const ask = (body: object) => assistantRoutes.request("/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: Q, lat: USER_LAT, lon: USER_LON, ...body }),
    });
    const res = await ask({ access_needs: ["pets"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.destination_resource_id).toBe(DEMO_RESOURCE_IDS.neighborhood);
    expect(body.route.recommendation.destination_resource_id).toBe(DEMO_RESOURCE_IDS.neighborhood);
    expect(body.recommended_action).toContain("Neighborhood Church");

    const bad = await ask({ access_needs: ["jetpack"] });
    expect(bad.status).toBe(400);
  });
});
