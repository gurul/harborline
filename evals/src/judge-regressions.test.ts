/**
 * Regressions for the critical judge pass on 895345e (docs/CRITICAL_REVIEW.md,
 * section 2026-11-15). Each test is named with its finding number and fails on
 * 895345e for the reason that finding gives. Only exports that existed at that
 * commit are used, so the file can run against it as a positive control.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  MemoryStore,
  calculateRoutes,
  composeResponse,
  gatherEvidence,
  planQuery,
  tools,
} from "@harborline/agent-tools";
import type { ToolContext } from "@harborline/agent-tools";
import { buildDemoFixtures, femaSheltersConnector, mapEventType } from "@harborline/connectors";
import type {
  CanonicalEvent,
  Connector,
  ConnectorResult,
  LonLat,
  Resource,
} from "@harborline/event-schema";
import { assistantRoutes } from "../../services/api/src/routes/assistant.js";
import { createRateLimit } from "../../services/api/src/rate-limit.js";
import { resetScheduler, startScheduler } from "../../services/api/src/scheduler.js";
import { isDemoMode, store as apiStore } from "../../services/api/src/state.js";
import {
  DEMO_EVENT_IDS,
  DEMO_RESOURCE_IDS,
  DEMO_USER_LOCATION,
  NOW,
  USER_LAT,
  USER_LON,
  evacuationOrderEvent,
  findEvent,
  findResource,
  seedScenario,
} from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetScheduler();
});

const SHELTER_QUESTION = "Where is the nearest open shelter?";
const CHURCH: LonLat = [-121.846, 39.7525];
const minutesAfter = (t: Date, n: number) => new Date(t.getTime() + n * 60_000);

function fireTemplate(): CanonicalEvent {
  return findEvent(buildDemoFixtures(NOW), DEMO_EVENT_IDS.fire);
}

function closure(id: string, coordinates: LonLat[]): CanonicalEvent {
  const template = findEvent(buildDemoFixtures(NOW), DEMO_EVENT_IDS.closureOleander);
  return { ...template, event_id: id, contradiction_note: null, geometry: { type: "LineString", coordinates } };
}

function band(id: string, west: number, east: number, south: number, north: number): CanonicalEvent {
  return {
    ...fireTemplate(),
    event_id: id,
    geometry: {
      type: "Polygon",
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    },
  };
}

function shelterAt(id: string, name: string, coordinates: LonLat, verifiedAt: Date): Resource {
  const template = findResource(buildDemoFixtures(NOW), DEMO_RESOURCE_IDS.neighborhood);
  return {
    ...template,
    resource_id: id,
    name,
    location: { type: "Point", coordinates },
    last_verified_at: verifiedAt.toISOString(),
  };
}

function chosenRoute(result: ReturnType<typeof tools.calculate_routes>) {
  return result.candidates.find((c) => c.route_id === result.recommendation?.route_id);
}

// ---------------------------------------------------------------------------

describe("J1: severe area hazards eliminate routes, and the summary never hides a crossing", () => {
  const EAST: LonLat = [-121.8305, 39.7415]; // just east of the fire polygon

  it("J1: does not recommend a route through the fresh severe fire", () => {
    const { store, ctx } = seedScenario();
    store.upsertResource(shelterAt("judge-east-side", "East Side Shelter", EAST, NOW));
    const evidence = gatherEvidence(ctx, SHELTER_QUESTION, DEMO_USER_LOCATION);
    expect(evidence.resources![0]!.resource_id).toBe("judge-east-side");
    const route = evidence.route!;
    const chosen = route.candidates.find((c) => c.route_id === route.recommendation?.route_id);
    expect(chosen?.intersecting_event_ids ?? []).not.toContain(DEMO_EVENT_IDS.fire);
    expect(route.candidates.some((c) => c.rejected_reason === "hazard_zone")).toBe(true);
    const response = composeResponse(SHELTER_QUESTION, evidence, NOW);
    expect(response.recommended_action ?? "").not.toMatch(/head for east side shelter/i);
    expect(response.answer_markdown).toContain("No route is currently verified as passable");
  });

  it("J1: a kept route through a lower-severity hazard area says so", () => {
    const { store, ctx } = seedScenario();
    store.upsertEvent({ ...fireTemplate(), severity: "moderate" }, []);
    store.upsertResource(shelterAt("judge-east-side", "East Side Shelter", EAST, NOW));
    const result = tools.calculate_routes(ctx, { from_lat: USER_LAT, from_lon: USER_LON, to_resource_id: "judge-east-side" });
    expect(result.recommendation).not.toBeNull();
    expect(chosenRoute(result)!.intersecting_event_ids).toContain(DEMO_EVENT_IDS.fire);
    expect(result.recommendation!.summary).not.toMatch(/avoids 0 reported hazards/);
    expect(result.recommendation!.summary).toMatch(/passes through or near 1 reported hazard area/);
  });
});

describe("J1+J4: a hazard-free route is found when the graph has one, refuge only when it has none", () => {
  it("J1+J4: returns the open Mangrove Ave route around a severe fire that blocks the three western roads", () => {
    const fire = band("judge-fire-west", -121.848, -121.8375, 39.7442, 39.7458);
    const result = calculateRoutes({ from: DEMO_USER_LOCATION, to: CHURCH, events: [fire], now: NOW });
    expect(result.best).not.toBeNull();
    expect(result.best!.intersecting_event_ids).not.toContain(fire.event_id);
    expect(result.best!.eliminated).toBe(false);
  });

  it("J1+J4: gives refuge advice when a severe fire spans every road", () => {
    const { store, ctx } = seedScenario();
    store.upsertEvent(band("judge-fire-wall", -121.86, -121.82, 39.7442, 39.7458), []);
    const evidence = gatherEvidence(ctx, SHELTER_QUESTION, DEMO_USER_LOCATION);
    expect(evidence.route!.recommendation).toBeNull();
    const response = composeResponse(SHELTER_QUESTION, evidence, NOW);
    expect(response.answer_markdown).toContain("No route is currently verified as passable");
    expect(response.recommended_action).not.toMatch(/head for/i);
  });
});

describe("J2: hazard containment fails closed on age", () => {
  it("J2: rejects a shelter inside the fire after the fire record passes its freshness limit", () => {
    const { store } = seedScenario();
    const later = minutesAfter(NOW, 57); // fire verified 61 min before `later`
    store.upsertResource(shelterAt("judge-inside", "Inside-Zone Shelter", [-121.8345, 39.7415], later));
    const ctx: ToolContext = { store, now: later };
    const result = tools.get_nearby_resources(ctx, { lat: USER_LAT, lon: USER_LON, resource_type: "shelter" });
    expect(result.recommendable.map((r) => r.resource_id)).not.toContain("judge-inside");
    expect(result.rejected.find((r) => r.resource.resource_id === "judge-inside")?.rejected_reason).toBe("inside_hazard_zone");
    const route = tools.calculate_routes(ctx, { from_lat: USER_LAT, from_lon: USER_LON, to_resource_id: "judge-inside" });
    expect(route.recommendation).toBeNull();
  });
});

describe("J3: a user inside an evacuation zone gets a route out", () => {
  const INSIDE: LonLat = [-121.8375, 39.744];

  it("J3: recommends a route that leaves the zone the user starts in", () => {
    const { store, ctx } = seedScenario();
    store.upsertEvent(evacuationOrderEvent(), []);
    const evidence = gatherEvidence(ctx, SHELTER_QUESTION, INSIDE);
    expect(evidence.route!.recommendation).not.toBeNull();
    const response = composeResponse(SHELTER_QUESTION, evidence, NOW);
    expect(response.recommended_action).toMatch(/head for neighborhood church/i);
  });

  it("J3: still eliminates routes into the zone for a user outside it", () => {
    const zone = evacuationOrderEvent();
    const result = calculateRoutes({ from: DEMO_USER_LOCATION, to: [-121.835, 39.7525], events: [zone], now: NOW });
    expect(result.best).toBeNull();
    expect(result.candidates.every((c) => c.rejected_reason === "evacuation_zone")).toBe(true);
  });
});

describe("J4: the router finds an open route that the k alternatives miss", () => {
  it("J4: routes around three closures between E 5th and E 7th by way of Mangrove Ave", () => {
    const events = [
      closure("judge-close-esplanade", [[-121.846, 39.7465], [-121.846, 39.7495]]),
      closure("judge-close-oleander", [[-121.8425, 39.7465], [-121.8425, 39.7495]]),
      closure("judge-close-arcadian", [[-121.839, 39.7465], [-121.839, 39.7495]]),
    ];
    const result = calculateRoutes({ from: DEMO_USER_LOCATION, to: CHURCH, events, now: NOW });
    expect(result.best).not.toBeNull();
    expect(result.best!.intersecting_event_ids).toEqual([]);
  });

  it("J4: a closure that ends at the destination intersection does not block the destination", () => {
    const events = [closure("judge-close-esplanade-north", [[-121.846, 39.7495], [-121.846, 39.7525]])];
    const result = calculateRoutes({ from: DEMO_USER_LOCATION, to: CHURCH, events, now: NOW });
    expect(result.best).not.toBeNull();
    expect(result.best!.intersecting_event_ids).toEqual([]);
  });
});

describe("J5: records a connector stops returning are reconciled", () => {
  function fakeConnector(results: (now: Date) => ConnectorResult[]): Connector {
    let call = 0;
    return {
      id: "judge-fake",
      label: "Judge fake connector",
      source_tier: "B",
      expected_refresh_seconds: 1,
      async fetch(now: Date) {
        const all = results(now);
        return all[Math.min(call++, all.length - 1)]!;
      },
    };
  }

  it("J5: closes an absent shelter and expires an absent event after a non-empty fetch, and ignores an empty one", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const store = new MemoryStore();
    const fire = fireTemplate();
    const otherEvent = { ...fire, event_id: "judge-event-kept" };
    const gone = (now: Date) => shelterAt("judge-gone", "Gone Shelter", [-121.846, 39.7525], now);
    const kept = (now: Date) => shelterAt("judge-kept", "Kept Shelter", [-121.8425, 39.7525], now);
    const ok = (now: Date, events: CanonicalEvent[], resources: Resource[]): ConnectorResult => ({
      ok: true, retrieved_at: now.toISOString(), events, resources, source_records: [],
    });
    const connector = fakeConnector((now) => [
      ok(now, [fire, otherEvent], [gone(now), kept(now)]),
      ok(now, [otherEvent], [kept(now)]),
      ok(now, [], []),
    ]);

    await startScheduler({ store, demoMode: false, connectors: [connector] });
    await vi.advanceTimersByTimeAsync(10);
    expect(store.getResource("judge-gone")!.operational_status).toBe("open");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getResource("judge-gone")!.operational_status).toBe("closed");
    expect(store.getEvent(fire.event_id)!.event.status).toBe("expired");
    expect(store.getResource("judge-kept")!.operational_status).toBe("open");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getResource("judge-kept")!.operational_status).toBe("open");
    expect(store.getEvent("judge-event-kept")!.event.status).toBe("active");

    const ctx: ToolContext = { store, now: new Date() };
    const nearby = tools.get_nearby_resources(ctx, { lat: USER_LAT, lon: USER_LON, resource_type: "shelter" });
    expect(nearby.recommendable.map((r) => r.resource_id)).not.toContain("judge-gone");
  });
});

describe("J6: NWS evacuation and fire alerts keep their type", () => {
  it("J6: maps evacuation and fire warnings before the weather fallback", () => {
    expect(mapEventType("Evacuation - Immediate")).toBe("evacuation_order");
    expect(mapEventType("Evacuation Order")).toBe("evacuation_order");
    expect(mapEventType("Fire Warning")).toBe("fire");
    expect(mapEventType("Flood Warning")).toBe("flood");
    expect(mapEventType("Heat Advisory")).toBe("weather_warning");
  });
});

describe("J7: demo data is opt-in and labelled", () => {
  it("J7: DEMO_MODE is off unless it is set to 1", () => {
    const saved = process.env.DEMO_MODE;
    try {
      delete process.env.DEMO_MODE;
      expect(isDemoMode()).toBe(false);
      process.env.DEMO_MODE = "";
      expect(isDemoMode()).toBe(false);
      process.env.DEMO_MODE = "0";
      expect(isDemoMode()).toBe(false);
      process.env.DEMO_MODE = "1";
      expect(isDemoMode()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = saved;
    }
  });

  it("J7: every demo provider name is marked as demo data", () => {
    const fixtures = buildDemoFixtures(NOW);
    const providers = [
      ...fixtures.source_records.map((r) => r.provider),
      ...fixtures.resources.map((r) => r.provider),
    ];
    for (const provider of providers) expect(provider).toMatch(/^DEMO\b/);
  });
});

describe("J8: on the LLM path, the recommended action comes from the route state", () => {
  const MODEL_ANSWER = "Neighborhood Church is the nearest shelter on record, verified 8 minutes ago.";
  const MODEL_ACTION = "Head for Neighborhood Church via Mangrove Ave now.";

  function anthropicReply() {
    const text = JSON.stringify({ answer_markdown: MODEL_ANSWER, recommended_action: MODEL_ACTION });
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }

  function openAiReply() {
    const text = JSON.stringify({ answer_markdown: MODEL_ANSWER, recommended_action: MODEL_ACTION });
    return new Response(
      JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text }] }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  function seedApiStore() {
    const { fixtures } = seedScenario();
    const byEvent = new Map<string, typeof fixtures.source_records>();
    for (const r of fixtures.source_records) {
      if (!r.event_id) continue;
      byEvent.set(r.event_id, [...(byEvent.get(r.event_id) ?? []), r]);
    }
    for (const e of fixtures.events) apiStore.upsertEvent(e, byEvent.get(e.event_id) ?? []);
    for (const r of fixtures.resources) apiStore.upsertResource(r);
  }

  async function ask() {
    const res = await assistantRoutes.request("/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: SHELTER_QUESTION, lat: USER_LAT, lon: USER_LON }),
    });
    expect(res.status).toBe(200);
    return res.json();
  }

  it("J8: replaces the model's action with the deterministic one when a route exists", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "judge-test-key");
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchMock = vi.fn(async () => anthropicReply());
    vi.stubGlobal("fetch", fetchMock);
    seedApiStore();
    const body = await ask();
    expect(fetchMock).toHaveBeenCalled();
    expect(body.composed_by).toBe("llm");
    expect(body.recommended_action).not.toContain("Mangrove");
    expect(body.recommended_action).toMatch(/lowest-risk route currently available/);
  });

  it("J8: an empty ANTHROPIC_API_KEY does not disable a valid OpenAI key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "judge-test-key");
    const fetchMock = vi.fn(async (_url: string | URL | Request) => openAiReply());
    vi.stubGlobal("fetch", fetchMock);
    seedApiStore();
    await ask();
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]![0])).toContain("api.openai.com");
  });

  it("J8: does not ask the model, or advise departure, when every route is eliminated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "judge-test-key");
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchMock = vi.fn(async () => anthropicReply());
    vi.stubGlobal("fetch", fetchMock);
    seedApiStore();
    apiStore.upsertEvent(closure("judge-barrier", [[-121.9, 39.746], [-121.78, 39.746]]), []);
    const body = await ask();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(body.recommended_action).not.toMatch(/head for/i);
    expect(body.answer_markdown).toContain("No route is currently verified as passable");
  });
});

describe("J9: the Camp Fire replay moves in time", () => {
  const T0 = new Date("2018-11-08T14:25:00Z");

  it("J9: a T0 seed queried at T0+80m rejects the fresh, open hospital inside the now-stale fire", () => {
    const { store } = seedScenario(T0);
    const now = minutesAfter(T0, 80);
    const template = findResource(buildDemoFixtures(T0), DEMO_RESOURCE_IDS.neighborhood);
    store.upsertResource({
      ...template,
      resource_id: "judge-feather-river",
      resource_type: "hospital",
      name: "Ridge Hospital (in fire zone)",
      location: { type: "Point", coordinates: [-121.834, 39.745] },
      last_verified_at: now.toISOString(),
    });
    const ctx: ToolContext = { store, now };
    const fire = tools.get_event_details(ctx, { event_id: DEMO_EVENT_IDS.fire })!;
    expect(fire.event.stale).toBe(true);
    const result = tools.get_nearby_resources(ctx, { lat: USER_LAT, lon: USER_LON, resource_type: "hospital" });
    expect(result.recommendable.map((r) => r.resource_id)).not.toContain("judge-feather-river");
  });

  it("J9: BENCHMARK criterion 1 is not marked Met while a route through the severe fire is recommended", () => {
    const { store, ctx } = seedScenario();
    store.upsertResource(shelterAt("judge-east-side", "East Side Shelter", [-121.8305, 39.7415], NOW));
    const result = tools.calculate_routes(ctx, { from_lat: USER_LAT, from_lon: USER_LON, to_resource_id: "judge-east-side" });
    const crossesFire = chosenRoute(result)?.intersecting_event_ids.includes(DEMO_EVENT_IDS.fire) ?? false;
    const benchmark = readFileSync(new URL("../../docs/BENCHMARK.md", import.meta.url), "utf8");
    const row = benchmark.split("\n").find((line) => /^\|\s*1\s*\|/.test(line)) ?? "";
    const claimsMet = /\|\s*\*\*Met\b/.test(row);
    expect(crossesFire && claimsMet).toBe(false);
  });
});

describe("J11: FEMA attribute coordinates keep their decimals", () => {
  it("J11: a null-geometry feature is placed at its attribute coordinates, not whole degrees", async () => {
    const payload = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        id: 7,
        geometry: null,
        properties: {
          shelter_name: "Attribute Shelter",
          shelter_status: "OPEN",
          state: "CA",
          latitude: 39.7285,
          longitude: -121.8375,
          last_updated: NOW.toISOString(),
        },
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200, headers: { "content-type": "application/json" },
    })));
    const result = await femaSheltersConnector.fetch(NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]!.location.coordinates).toEqual([-121.8375, 39.7285]);
  });
});

describe("J12: with TRUST_PROXY=1 the client cannot choose its rate-limit key", () => {
  it("J12: keys on the proxy-appended last X-Forwarded-For hop", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    const limiter = createRateLimit({ limit: 6, name: "judge" });
    try {
      const app = new Hono();
      app.use("*", limiter.middleware);
      app.get("/", (c) => c.text("ok"));
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) {
        const res = await app.request("/", { headers: { "x-forwarded-for": `10.0.0.${i}, 203.0.113.9` } });
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 429).length).toBe(4);
    } finally {
      limiter.stop();
    }
  });
});

describe("J15: evacuation questions compute a route; named resources filter by type", () => {
  it("J15: routes 'What is the evacuation route?' and 'How do I get out of here?'", () => {
    const { ctx } = seedScenario();
    for (const question of ["What is the evacuation route?", "How do I get out of here?"]) {
      expect(planQuery(question).intent).toBe("nearest_shelter");
      const evidence = gatherEvidence(ctx, question, DEMO_USER_LOCATION);
      expect(evidence.route?.recommendation).toBeTruthy();
    }
  });

  it("J15: 'Where is the nearest hospital?' lists hospitals, not shelters", () => {
    const { store, ctx } = seedScenario();
    const template = findResource(buildDemoFixtures(NOW), DEMO_RESOURCE_IDS.neighborhood);
    store.upsertResource({ ...template, resource_id: "judge-hospital", resource_type: "hospital", name: "Enloe Annex", location: { type: "Point", coordinates: [-121.8425, 39.7525] } });
    const evidence = gatherEvidence(ctx, "Where is the nearest hospital?", DEMO_USER_LOCATION);
    const types = new Set((evidence.resources ?? []).map((r) => r.resource_type));
    expect([...types]).toEqual(["hospital"]);
  });
});
