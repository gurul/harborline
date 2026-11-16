/**
 * Observation connectors: AirNow reporting-area file, NOAA NWPS gauges, and
 * NOAA HMS smoke polygons. Fixtures are real responses recorded on
 * 2026-11-16 around 05:57 UTC (the two large ones gzip-compressed).
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  airnowConnector,
  gaugesToObservations,
  hmsSmokeConnector,
  hmsTime,
  nwpsConnector,
  parseReportingArea,
  reportingAreaToObservations,
  smokeToObservations,
} from "@harborline/connectors";
import { MemoryStore } from "@harborline/agent-tools";
import { FRESHNESS_POLICY, ObservationSchema, aqiCategory } from "@harborline/event-schema";

const AT = new Date("2026-11-16T05:58:00Z");
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const AIRNOW = gunzipSync(readFileSync(fixture("airnow-reportingarea-2026-11-16T0557Z.dat.gz"))).toString("utf8");
const NWPS = JSON.parse(gunzipSync(readFileSync(fixture("nwps-gauges-ca-2026-11-16T0556Z.json.gz"))).toString("utf8"));
const SMOKE = JSON.parse(readFileSync(fixture("hms-smoke-ca-2026-11-16T0600Z.geojson"), "utf8"));

afterEach(() => { vi.unstubAllGlobals(); });

describe("AirNow reporting-area file", () => {
  const parsed = parseReportingArea(AIRNOW);
  const observations = parsed.ok ? reportingAreaToObservations(parsed.rows, AT) : [];

  it("reads the agency AQI for Chico with its category, pollutant and UTC time", () => {
    expect(parsed.ok).toBe(true);
    const chico = observations.find((o) => o.name === "Chico, CA")!;
    expect(chico).toBeDefined();
    // 21:00 PST on 11/15 is 05:00 UTC on 11/16; PM2.5 is the primary pollutant.
    expect(chico.observed_at).toBe("2026-11-16T05:00:00.000Z");
    expect(chico.aqi).toBe(39);
    expect(chico.category).toBe("Good");
    expect(chico.pollutant).toBe("PM2.5");
    expect(chico.provider_tier).toBe("B");
    expect(chico.provider).toContain("Butte County Air Quality Management District");
  });

  it("keeps one valid observation per reporting area inside the region box", () => {
    expect(observations.length).toBe(135);
    expect(new Set(observations.map((o) => o.observation_id)).size).toBe(observations.length);
    for (const o of observations) expect(ObservationSchema.safeParse(o).success).toBe(true);
    expect(observations.find((o) => o.name.endsWith(", ID"))).toBeUndefined();
  });

  it("rejects a body that is not the reporting-area file", () => {
    expect(parseReportingArea("<html>error</html>").ok).toBe(false);
  });

  it("returns ok:false through the connector for an error page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>gone</html>")));
    expect((await airnowConnector.fetch(AT)).ok).toBe(false);
  });

  it("maps AQI to EPA categories at the boundaries", () => {
    expect(aqiCategory(50)).toBe("Good");
    expect(aqiCategory(51)).toBe("Moderate");
    expect(aqiCategory(101)).toBe("Unhealthy for Sensitive Groups");
    expect(aqiCategory(151)).toBe("Unhealthy");
    expect(aqiCategory(201)).toBe("Very Unhealthy");
    expect(aqiCategory(301)).toBe("Hazardous");
  });
});

describe("NWPS gauges", () => {
  const gauges = gaugesToObservations(NWPS, AT);

  it("reads stage, flow and both flood categories for Butte City", () => {
    const btcc1 = gauges.find((g) => g.site_id === "BTCC1")!;
    expect(btcc1.stage_ft).toBe(69.36);
    expect(btcc1.flow_cfs).toBe(5700);
    expect(btcc1.flood_category).toBe("no_flooding");
    expect(btcc1.forecast_category).toBe("no_flooding");
    expect(btcc1.observed_at).toBe("2026-11-16T04:30:00.000Z");
    expect(btcc1.provider_tier).toBe("A");
  });

  it("keeps action and moderate gauges and never reads an unrated gauge as no flooding", () => {
    expect(gauges.find((g) => g.site_id === "KCYC1")!.flood_category).toBe("moderate");
    expect(gauges.filter((g) => g.flood_category === "action")).toHaveLength(2);
    const notDefined = (NWPS.gauges as { lid: string; status: { observed: { floodCategory: string } } }[])
      .filter((g) => g.status.observed.floodCategory === "not_defined")
      .map((g) => g.lid);
    const mapped = gauges.filter((g) => notDefined.includes(g.site_id));
    expect(mapped.length).toBeGreaterThan(0);
    expect(mapped.every((g) => g.flood_category === "unknown")).toBe(true);
  });

  it("drops out-of-service gauges and -999 sentinels", () => {
    const outOfService = (NWPS.gauges as { status: { observed: { floodCategory: string } } }[])
      .filter((g) => g.status.observed.floodCategory === "out_of_service").length;
    expect(outOfService).toBe(59);
    expect(gauges.length).toBeLessThanOrEqual(988 - 59);
    expect(gauges.every((g) => g.stage_ft === null || g.stage_ft > -900)).toBe(true);
    expect(gauges.find((g) => g.site_id === "CNJC1")!.flow_cfs).toBeNull();
    expect(gauges.find((g) => g.site_id === "CNJC1")!.forecast_category).toBeNull();
  });

  it("returns ok:false for a payload with no gauges array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "error" }))));
    expect((await nwpsConnector.fetch(AT)).ok).toBe(false);
  });
});

describe("HMS smoke polygons", () => {
  it("converts day-of-year times", () => {
    expect(hmsTime("2026319 1610")).toBe("2026-11-15T16:10:00.000Z");
    expect(hmsTime("2026320 0000")).toBe("2026-11-16T00:00:00.000Z");
    expect(hmsTime("garbage")).toBeNull();
  });

  it("turns each recorded polygon into a smoke observation", () => {
    const smoke = smokeToObservations(SMOKE, AT);
    expect(smoke).toHaveLength(3);
    expect(smoke.every((s) => s.density === "light")).toBe(true);
    expect(smoke.map((s) => s.observed_at).sort().at(-1)).toBe("2026-11-16T00:00:00.000Z");
    expect(smoke.every((s) => s.location.coordinates[0] !== 0)).toBe(true);
  });

  it("returns ok:false on a service error object", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: 500 } }))));
    expect((await hmsSmokeConnector.fetch(AT)).ok).toBe(false);
  });
});

describe("store: observations age by freshness", () => {
  it("keeps the newer reading and sweeps a reading past 4 x its budget", () => {
    const parsed = parseReportingArea(AIRNOW);
    if (!parsed.ok) throw new Error(parsed.error);
    const chico = reportingAreaToObservations(parsed.rows, AT).find((o) => o.name === "Chico, CA")!;
    const store = new MemoryStore();
    store.upsertObservation(chico);
    store.upsertObservation({ ...chico, aqi: 1, last_verified_at: "2026-11-16T03:00:00.000Z" });
    const kept = store.queryObservations({ center: [-121.84, 39.75], kind: "air_quality" })[0]!;
    expect(kept.kind === "air_quality" && kept.aqi).toBe(39);

    const budget = FRESHNESS_POLICY.observations.air_quality * 1000;
    store.sweepExpired(new Date(new Date(chico.last_verified_at).getTime() + 4 * budget - 60_000));
    expect(store.allObservations()).toHaveLength(1);
    store.sweepExpired(new Date(new Date(chico.last_verified_at).getTime() + 4 * budget + 60_000));
    expect(store.allObservations()).toHaveLength(0);
  });
});
