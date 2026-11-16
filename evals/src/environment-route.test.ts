/**
 * GET /v1/environment, the `exclude_types` filter on GET /v1/events, and the
 * stream's resync frame.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEvent, makeSourceRecord } from "@harborline/connectors";
import type { CanonicalEvent, Connector, Observation } from "@harborline/event-schema";
import { environmentRoutes } from "../../services/api/src/routes/environment.js";
import { eventsRoutes } from "../../services/api/src/routes/events.js";
import { MAX_PENDING_EVENTS, streamRoutes } from "../../services/api/src/routes/stream.js";
import { resetScheduler, startScheduler } from "../../services/api/src/scheduler.js";
import { store as apiStore } from "../../services/api/src/state.js";

const NOW = new Date("2026-11-16T06:00:00Z");
const AT: [number, number] = [-121.84, 39.75];
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

afterEach(() => {
  resetScheduler();
  vi.useRealTimers();
});

function air(id: string, aqi: number, at: [number, number], ageMin: number): Observation {
  return {
    kind: "air_quality",
    observation_id: id,
    name: `Area ${id}`,
    location: { type: "Point", coordinates: at },
    observed_at: minutesAgo(ageMin),
    last_verified_at: minutesAgo(ageMin),
    provider: "AirNow (EPA and partner agencies)",
    provider_tier: "B",
    source_url: "https://www.airnow.gov/",
    aqi,
    category: aqi <= 50 ? "Good" : "Moderate",
    pollutant: "PM2.5",
  };
}

function detection(id: string, center: [number, number], ageMin: number): { event: CanonicalEvent; records: ReturnType<typeof makeSourceRecord>[] } {
  const [x, y] = center;
  const d = 0.003;
  const verified = minutesAgo(ageMin);
  const event = makeEvent({
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
  }, NOW);
  const records = [makeSourceRecord({
    source_record_id: `rec-${id}`,
    event_id: id,
    provider: "NASA FIRMS (VIIRS)",
    provider_record_id: null,
    provider_tier: "C",
    source_url: "https://firms.modaps.eosdis.nasa.gov/active_fire/",
    published_at: verified,
    retrieved_at: NOW.toISOString(),
    hash_input: id,
  })];
  return { event, records };
}

const healthyFireFeed: Connector = {
  id: "firms-viirs",
  label: "fake healthy detections",
  source_tier: "C",
  expected_refresh_seconds: 3600,
  zero_rows_expected: true,
  async fetch(now) {
    return { ok: true, retrieved_at: now.toISOString(), events: [], resources: [], source_records: [] };
  },
};

async function getEnv(query: string) {
  const res = await environmentRoutes.request(`/?${query}`);
  return { status: res.status, body: await res.json() };
}

describe("GET /v1/environment", () => {
  it("returns 400 naming lat when lat is blank", async () => {
    const { status, body } = await getEnv(`lat=&lon=${AT[0]}`);
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_query");
    expect(body.message).toContain("`lat`");
  });

  it("reports no_data for fire and not_monitored for power before any fire feed has fetched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { status, body } = await getEnv(`lat=${AT[1]}&lon=${AT[0]}&radius_m=5000`);
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["air_quality", "fire", "generated_at", "power", "sources", "stream_gauge"]);
    expect(body.fire.status).toBe("no_data");
    expect(body.power.status).toBe("not_monitored");
    expect(body.power.note).not.toMatch(/no outage|normal/i);
    expect(body.air_quality.status).toBe("no_data");
  });

  it("serves provenance and age for every section and marks a stale reading stale", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    await startScheduler({ store: apiStore, demoMode: false, connectors: [healthyFireFeed] });
    await vi.advanceTimersByTimeAsync(10);

    apiStore.upsertObservation(air("near-old", 140, [AT[0] + 0.01, AT[1]], 5 * 60));
    apiStore.upsertObservation({
      kind: "stream_gauge",
      observation_id: "nwps:test1",
      name: "Test Creek at Chico",
      location: { type: "Point", coordinates: [AT[0], AT[1] + 0.02] },
      observed_at: minutesAgo(30),
      last_verified_at: minutesAgo(30),
      provider: "NOAA NWPS",
      provider_tier: "A",
      source_url: "https://water.noaa.gov/gauges/test1",
      site_id: "TEST1",
      stage_ft: 12.5,
      flow_cfs: null,
      flood_category: "action",
      forecast_category: "minor",
    });
    const det = detection("env-det-1", [AT[0] + 0.03, AT[1]], 90);
    apiStore.upsertEvent(det.event, det.records);

    const { status, body } = await getEnv(`lat=${AT[1]}&lon=${AT[0]}&radius_m=10000`);
    expect(status).toBe(200);
    // The only air reading is 5 h old against a 2 h budget.
    expect(body.air_quality.status).toBe("stale");
    expect(body.air_quality.aqi).toBe(140);
    for (const section of [body.air_quality, body.stream_gauge]) {
      expect(section.provider).toBeTruthy();
      expect(section.provider_tier).toMatch(/^[A-E]$/);
      expect(section.last_verified_at).toBeTruthy();
      expect(section.age_label).toMatch(/ago/);
      expect(typeof section.distance_m).toBe("number");
    }
    expect(body.stream_gauge).toMatchObject({ status: "ok", flood_category: "action", forecast_category: "minor", stage_ft: 12.5, site_id: "TEST1" });
    expect(body.fire).toMatchObject({ status: "ok", detections: 1, perimeters: 0, confirmed: false });
    expect(body.fire.newest_age_label).toBe("2 h ago");
    expect(body.fire.note).toMatch(/unconfirmed by a fire agency/);
    expect(body.sources.map((s: { provider: string }) => s.provider)).toEqual(
      expect.arrayContaining(["NOAA NWPS", "NASA FIRMS (VIIRS)", "AirNow (EPA and partner agencies)"]),
    );

    // A fresh reading further away wins over the stale near one.
    apiStore.upsertObservation(air("far-fresh", 42, [AT[0] + 0.05, AT[1]], 30));
    const again = await getEnv(`lat=${AT[1]}&lon=${AT[0]}&radius_m=10000`);
    expect(again.body.air_quality).toMatchObject({ status: "ok", aqi: 42, category: "Good" });
  });

  it("with a healthy feed and zero detections, says that is not proof of no fire", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    await startScheduler({ store: apiStore, demoMode: false, connectors: [healthyFireFeed] });
    await vi.advanceTimersByTimeAsync(10);
    // Far from every record seeded above.
    const { body } = await getEnv("lat=34.0&lon=-118.0&radius_m=5000");
    expect(body.fire).toMatchObject({ status: "ok", detections: 0, perimeters: 0, confirmed: false });
    expect(body.fire.note).toMatch(/not proof of no fire/);
  });
});

describe("GET /v1/events exclude_types", () => {
  it("keeps a closure that 150 detections would otherwise push past the limit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const closure = makeEvent({
      event_id: "env-closure",
      event_type: "road_closure",
      headline: "Test closure",
      description: "test",
      severity: "moderate",
      urgency: "immediate",
      certainty: "observed",
      geometry: { type: "LineString", coordinates: [[-121.6, 39.6], [-121.6, 39.61]] },
      starts_at: minutesAgo(200),
      ends_at: null,
      last_verified_at: minutesAgo(200),
      best_tier: "B",
    }, NOW);
    apiStore.upsertEvent(closure, []);
    for (let i = 0; i < 150; i++) {
      const det = detection(`bulk-det-${i}`, [-121.6 + i * 0.001, 39.6], 10);
      apiStore.upsertEvent(det.event, det.records);
    }
    const ids = async (q: string) =>
      ((await (await eventsRoutes.request(`/?${q}`)).json()).events as CanonicalEvent[]).map((e) => e.event_id);

    // The failure this filter exists for: newer moderate detections fill the cap.
    expect(await ids("limit=100")).not.toContain("env-closure");
    const filtered = await ids("limit=100&exclude_types=fire_detection");
    expect(filtered).toContain("env-closure");
    expect(filtered.some((id) => id.startsWith("bulk-det-"))).toBe(false);

    const bad = await eventsRoutes.request("/?exclude_types=not_a_type");
    expect(bad.status).toBe(400);
  });
});

describe("GET /v1/stream resync", () => {
  it("tells a client that fell behind to refetch /v1/events", async () => {
    const res = await streamRoutes.request("/");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // Let the handler subscribe, then push more updates than the buffer holds.
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < MAX_PENDING_EVENTS + 20; i++) {
      const det = detection(`flood-det-${i}`, [-120 + i * 0.001, 38], 5);
      apiStore.upsertEvent(det.event, det.records);
    }
    let text = "";
    const deadline = Date.now() + 3000;
    while (!text.includes("event: resync") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    expect(text).toContain("event: resync");
    expect(text).toContain('"refetch":"/v1/events"');
  });
});
