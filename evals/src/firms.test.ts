/**
 * Satellite detection connector (NASA FIRMS keyless VIIRS files).
 *
 * The recorded fixtures are the real NOAA-20 and NOAA-21 24 h files as served
 * on 2026-11-16 at 05:56 UTC.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRMS_FILES,
  FIRMS_INFO_URL,
  FOOTPRINT_MARGIN_M,
  FEED_USER_AGENT,
  clusterSeverity,
  detectionsToEvents,
  firmsConnector,
  parseFirmsCsv,
  regionRows,
  type FirmsDetection,
} from "@harborline/connectors";
import { CanonicalEventSchema, haversineMeters, type LonLat } from "@harborline/event-schema";

const FIXTURE_AT = new Date("2026-11-16T05:56:00Z");
const N20 = readFileSync(new URL("./fixtures/firms-noaa20-24h-2026-11-16T0556Z.csv", import.meta.url), "utf8");
const N21 = readFileSync(new URL("./fixtures/firms-noaa21-24h-2026-11-16T0556Z.csv", import.meta.url), "utf8");
const HEADER = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight";

function row(lat: number, lon: number, date: string, time: string, sat: string, conf: string, scan = 0.4, track = 0.4): string {
  return `${lat},${lon},330.0,${scan},${track},${date},${time},${sat},${conf},2.0NRT,290.0,5.0,D`;
}

function rowsOf(csv: string): FirmsDetection[] {
  const parsed = parseFirmsCsv(csv);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.rows;
}

function stubFiles(bodies: Record<string, { status?: number; body: string }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const hit = Object.entries(bodies).find(([key]) => url.includes(key));
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(hit[1].body, { status: hit[1].status ?? 200 });
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("FIRMS: normalization from the recorded files", () => {
  const rows = [...rowsOf(N20), ...rowsOf(N21)];
  const inRegion = regionRows(rows, FIXTURE_AT);
  const { events, source_records } = detectionsToEvents(inRegion, FIXTURE_AT, FIXTURE_AT.toISOString());

  it("parses every row of both files and keeps the 110 inside the region box", () => {
    expect(rowsOf(N20)).toHaveLength(938);
    expect(rowsOf(N21)).toHaveLength(852);
    expect(inRegion).toHaveLength(110);
  });

  it("emits valid tier C fire_detection events, one source record per cluster", () => {
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(inRegion.length);
    expect(source_records).toHaveLength(events.length);
    for (const event of events) {
      expect(CanonicalEventSchema.safeParse(event).success).toBe(true);
      expect(event.event_type).toBe("fire_detection");
      expect(event.best_tier).toBe("C");
      expect(event.urgency).toBe("unknown");
      expect(event.severity).not.toBe("extreme");
      expect(event.geometry.type).toBe("MultiPolygon");
      expect(event.description).toMatch(/Not confirmed by a fire agency/);
      // ends_at is the newest pixel + 24 h.
      expect(new Date(event.ends_at!).getTime() - new Date(event.last_verified_at).getTime()).toBe(24 * 3600_000);
    }
    const pixels = events.reduce((n, e) => n + (e.geometry.coordinates as unknown[]).length, 0);
    expect(pixels).toBe(110);
    expect(new Set(source_records.map((r) => r.source_url))).toEqual(new Set([FIRMS_INFO_URL]));
  });

  it("takes the event time from the newest pixel's acq_date and acq_time", () => {
    const newestRow = inRegion.reduce((a, b) => (b.observed_at > a.observed_at ? b : a));
    expect(events.some((e) => e.last_verified_at === newestRow.observed_at)).toBe(true);
    expect(newestRow.observed_at).toMatch(/^2026-11-1[56]T\d{2}:\d{2}:00\.000Z$/);
  });

  it("sizes a footprint from scan and track plus the margin", () => {
    const single = detectionsToEvents(
      rowsOf(`${HEADER}\n${row(39.88, -122.08, "2026-11-16", "0100", "N20", "nominal", 0.42, 0.38)}`),
      FIXTURE_AT,
      FIXTURE_AT.toISOString(),
    ).events[0]!;
    const ring = (single.geometry.coordinates as LonLat[][][])[0]![0]!;
    const width = haversineMeters(ring[0]!, ring[1]!);
    const height = haversineMeters(ring[1]!, ring[2]!);
    expect(width).toBeCloseTo(420 + 2 * FOOTPRINT_MARGIN_M, -1);
    expect(height).toBeCloseTo(380 + 2 * FOOTPRINT_MARGIN_M, -1);
  });
});

describe("FIRMS: cluster severity", () => {
  it("marks a cluster seen by NOAA-20 and NOAA-21 within 12 h as severe", () => {
    const rows = rowsOf([HEADER, row(39.8, -121.8, "2026-11-16", "0100", "N20", "nominal"), row(39.8005, -121.8, "2026-11-16", "0150", "N21", "low")].join("\n"));
    const { events } = detectionsToEvents(rows, FIXTURE_AT, FIXTURE_AT.toISOString());
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("severe");
  });

  it("treats two granules of one overpass as one pass (moderate)", () => {
    const rows = rowsOf([HEADER, row(39.8, -121.8, "2026-11-16", "0059", "N20", "nominal"), row(39.8005, -121.8, "2026-11-16", "0100", "N20", "nominal")].join("\n"));
    expect(clusterSeverity(rows).severity).toBe("moderate");
  });

  it("marks an all-low-confidence cluster minor, even across two passes", () => {
    const rows = rowsOf([HEADER, row(39.8, -121.8, "2026-11-16", "0100", "N20", "low"), row(39.8, -121.8, "2026-11-16", "0150", "N21", "low")].join("\n"));
    expect(clusterSeverity(rows).severity).toBe("minor");
  });

  it("marks a cluster on a known permanent heat source minor and says why", () => {
    const rows = rowsOf([HEADER, row(39.8, -121.8, "2026-11-16", "0100", "N20", "high"), row(39.8, -121.8, "2026-11-16", "0150", "N21", "high")].join("\n"));
    const result = clusterSeverity(rows, [{ name: "Test refinery", center: [-121.8, 39.8], radius_m: 1000 }]);
    expect(result.severity).toBe("minor");
    expect(result.reason).toContain("Test refinery");
  });

  it("keeps pixels 5 km apart as two clusters with stable ids across polls", () => {
    const csv = [HEADER, row(39.8, -121.8, "2026-11-16", "0100", "N20", "nominal"), row(39.845, -121.8, "2026-11-16", "0100", "N20", "nominal")].join("\n");
    const first = detectionsToEvents(rowsOf(csv), FIXTURE_AT, FIXTURE_AT.toISOString()).events;
    const later = new Date(FIXTURE_AT.getTime() + 30 * 60_000);
    const second = detectionsToEvents(rowsOf(csv), later, later.toISOString()).events;
    expect(first).toHaveLength(2);
    expect(second.map((e) => e.event_id)).toEqual(first.map((e) => e.event_id));
  });

  it("drops rows outside the region box and older than 24 h", () => {
    const rows = rowsOf([
      HEADER,
      row(39.8, -121.8, "2026-11-16", "0100", "N20", "nominal"),
      row(45.0, -100.0, "2026-11-16", "0100", "N20", "nominal"),
      row(39.8, -121.8, "2026-11-15", "0500", "N20", "nominal"),
    ].join("\n"));
    expect(regionRows(rows, FIXTURE_AT)).toHaveLength(1);
  });
});

describe("FIRMS connector: fetch outcomes", () => {
  it("returns ok:true with zero events for header-only files", async () => {
    const calls = stubFiles({ "noaa-20": { body: `${HEADER}\n` }, "noaa-21": { body: `${HEADER}\n` } });
    const result = await firmsConnector.fetch(FIXTURE_AT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.events).toHaveLength(0);
    expect(calls.map((c) => c.url).sort()).toEqual(FIRMS_FILES.map((f) => f.url).sort());
    for (const call of calls) {
      expect((call.init?.headers as Record<string, string>)["User-Agent"]).toBe(FEED_USER_AGENT);
    }
    expect(firmsConnector.zero_rows_expected).toBe(true);
  });

  it("normalizes the recorded files through the connector", async () => {
    stubFiles({ "noaa-20": { body: N20 }, "noaa-21": { body: N21 } });
    const result = await firmsConnector.fetch(FIXTURE_AT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.events.length).toBeGreaterThan(0);
  });

  it("returns ok:false for a body that is not the FIRMS CSV", async () => {
    stubFiles({ "noaa-20": { body: "Invalid MAP_KEY." }, "noaa-21": { body: N21 } });
    const result = await firmsConnector.fetch(FIXTURE_AT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/NOAA-20 file: not a FIRMS active-fire CSV/);
  });

  it("returns ok:false when either satellite's file fails, so nothing is reconciled away", async () => {
    stubFiles({ "noaa-20": { body: N20 }, "noaa-21": { status: 503, body: "busy" } });
    const result = await firmsConnector.fetch(FIXTURE_AT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/NOAA-21 file: HTTP 503/);
  });
});
