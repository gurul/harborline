/**
 * Interagency wildfire perimeter and incident connector (NIFC WFIGS).
 *
 * Recorded fixtures: the region-box responses of both current layers on
 * 2026-11-16 at 05:56 UTC, plus three national perimeters (the region had one
 * perimeter, fully contained).
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WFIGS_INCIDENTS_LAYER,
  WFIGS_PERIMETERS_LAYER,
  containmentSeverity,
  wfigsConnector,
  wfigsQueryUrl,
  wfigsToEvents,
} from "@harborline/connectors";
import { CanonicalEventSchema, REGION } from "@harborline/event-schema";

const AT = new Date("2026-11-16T05:56:00Z");
const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
    // Recorded GeoJSON: geometry is { type, coordinates } or null.
    features: {
      geometry: { type: string; coordinates: unknown } | null;
      properties: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    }[];
  };
const PERIMETERS_CA = load("wfigs-perimeters-ca-2026-11-16T0556Z.geojson");
const INCIDENTS_CA = load("wfigs-incidents-ca-2026-11-16T0556Z.geojson");
const PERIMETERS_US = load("wfigs-perimeters-national-sample-2026-11-16T0556Z.geojson");

afterEach(() => { vi.unstubAllGlobals(); });

describe("WFIGS: severity by percent contained", () => {
  it("is severe below 50 percent or when not reported, moderate from 50, skipped at 100", () => {
    expect(containmentSeverity(10, "WF")!.severity).toBe("severe");
    expect(containmentSeverity(null, "WF")!.severity).toBe("severe");
    expect(containmentSeverity(null, "WF")!.phrase).toBe("containment not reported");
    expect(containmentSeverity(50, "WF")!.severity).toBe("moderate");
    expect(containmentSeverity(99, "WF")!.severity).toBe("moderate");
    expect(containmentSeverity(100, "WF")).toBeNull();
  });

  it("caps a prescribed fire at moderate and says it is prescribed", () => {
    const rx = containmentSeverity(null, "RX")!;
    expect(rx.severity).toBe("moderate");
    expect(rx.phrase).toMatch(/prescribed/);
  });
});

describe("WFIGS: normalization from the recorded responses", () => {
  it("maps the national perimeters by containment (59 and 90 percent moderate, 100 percent skipped)", () => {
    const { events, source_records } = wfigsToEvents(PERIMETERS_US.features, [], AT, AT.toISOString());
    expect(events.map((e) => e.headline)).toEqual([
      "Wild River fire perimeter (59% contained)",
      "Foot Creek fire perimeter (90% contained)",
    ]);
    for (const event of events) {
      expect(CanonicalEventSchema.safeParse(event).success).toBe(true);
      expect(event.event_type).toBe("fire_perimeter");
      expect(event.best_tier).toBe("B");
      expect(event.severity).toBe("moderate");
      expect(["Polygon", "MultiPolygon"]).toContain(event.geometry.type);
    }
    // poly_DateCurrent (epoch ms) is the verification time.
    expect(events[0]!.last_verified_at).toBe(new Date(1794271591000).toISOString());
    expect(source_records).toHaveLength(2);
  });

  it("turns the region's incidents into location-only records, skipping the contained and the mapped", () => {
    const { events } = wfigsToEvents(PERIMETERS_CA.features, INCIDENTS_CA.features, AT, AT.toISOString());
    // The region's one perimeter (Timber) is 100% contained: no polygon event.
    expect(events.every((e) => e.geometry.type === "Point")).toBe(true);
    const wildfires = INCIDENTS_CA.features.filter(
      (f) => f.properties.IncidentTypeCategory === "WF" && (f.properties.PercentContained ?? 0) < 100,
    );
    const prescribed = INCIDENTS_CA.features.filter((f) => f.properties.IncidentTypeCategory === "RX");
    expect(events.filter((e) => e.severity === "severe")).toHaveLength(wildfires.length);
    expect(events.filter((e) => e.severity === "moderate")).toHaveLength(prescribed.length);
    expect(events.length).toBe(wildfires.length + prescribed.length);
    expect(events[0]!.headline).toMatch(/location only/);
    expect(events[0]!.description).toMatch(/not its extent/);
  });

  it("drops a perimeter with an unclosed ring", () => {
    const open = {
      geometry: { type: "Polygon", coordinates: [[[-121.8, 39.7], [-121.7, 39.7], [-121.7, 39.8], [-121.8, 39.8]]] },
      properties: { poly_IncidentName: "Open Ring", attr_PercentContained: 5, attr_IrwinID: "{X}" },
    };
    const { events, dropped } = wfigsToEvents([open], [], AT, AT.toISOString());
    expect(events).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it("makes a severe perimeter from an uncontained polygon", () => {
    const fire = {
      geometry: { type: "Polygon", coordinates: [[[-121.8, 39.7], [-121.7, 39.7], [-121.7, 39.8], [-121.8, 39.8], [-121.8, 39.7]]] },
      properties: { poly_IncidentName: "Test", attr_PercentContained: 20, attr_IncidentTypeCategory: "WF", attr_IrwinID: "{ABC}", poly_DateCurrent: 1794271591000 },
    };
    const { events } = wfigsToEvents([fire], [], AT, AT.toISOString());
    expect(events[0]!.severity).toBe("severe");
    expect(events[0]!.event_id).toBe("wfigs:abc");
  });
});

describe("WFIGS connector: fetch outcomes", () => {
  it("filters both layers by the region box", () => {
    for (const layer of [WFIGS_PERIMETERS_LAYER, WFIGS_INCIDENTS_LAYER]) {
      const url = new URL(wfigsQueryUrl(layer));
      expect(url.searchParams.get("geometry")).toBe(REGION.bbox.join(","));
      expect(url.searchParams.get("geometryType")).toBe("esriGeometryEnvelope");
      expect(url.searchParams.get("f")).toBe("geojson");
    }
  });

  it("returns ok:true from the recorded region responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.includes("Perimeters") ? PERIMETERS_CA : INCIDENTS_CA), { status: 200 })));
    const result = await wfigsConnector.fetch(AT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.events.length).toBeGreaterThan(0);
  });

  it("returns ok:false when a layer answers with a service error object", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.includes("Perimeters") ? { error: { code: 400, message: "Invalid query" } } : INCIDENTS_CA), { status: 200 })));
    const result = await wfigsConnector.fetch(AT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/WFIGS perimeters: service error/);
  });

  it("returns ok:false when a layer stays truncated past the page limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ features: [], exceededTransferLimit: true }), { status: 200 })));
    const result = await wfigsConnector.fetch(AT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/snapshot incomplete/);
  });
});
