/**
 * Wildfire smoke: NOAA Hazard Mapping System (HMS) smoke polygons, keyless
 * ArcGIS FeatureServer, GeoJSON.
 *
 * Analysts draw smoke areas from GOES imagery a few times a day, with density
 * Light, Medium or Heavy. The layer holds the current analysis day. Each
 * polygon becomes a `smoke` observation: it informs air-quality and fire
 * answers and never affects routing or shelter choice.
 *
 * Times are "YYYYDDD HHMM" (day of year, UTC). `FID` restarts each day, so the
 * observation id is a hash of the analysis fields instead.
 */
import { z } from "zod";
import {
  ObservationSchema,
  REGION,
  geometryCentroid,
  type Connector,
  type ConnectorResult,
  type SmokeDensity,
  type SmokeObservation,
} from "@harborline/event-schema";
import {
  FEED_USER_AGENT,
  errorMessage,
  fetchJson,
  hashContent,
  stableStringify,
} from "./util.js";

export const HMS_SMOKE_LAYER =
  "https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0";
export const HMS_PROVIDER = "NOAA Hazard Mapping System (smoke analysis)";
export const HMS_INFO_URL = "https://www.ospo.noaa.gov/products/land/hms.html";

export function hmsSmokeQueryUrl(): string {
  const [w, s, e, n] = REGION.bbox;
  const params = new URLSearchParams({
    where: "1=1",
    geometry: `${w},${s},${e},${n}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "Satellite,Start,End_,Density",
    outSR: "4326",
    f: "geojson",
  });
  return `${HMS_SMOKE_LAYER}/query?${params.toString()}`;
}

const CollectionSchema = z.looseObject({
  features: z.array(z.looseObject({
    geometry: z.unknown(),
    properties: z.record(z.string(), z.unknown()).nullish(),
  })).nullish(),
  exceededTransferLimit: z.boolean().nullish(),
  properties: z.looseObject({ exceededTransferLimit: z.boolean().nullish() }).nullish(),
  error: z.unknown().optional(),
});

/** "2026319 1610" -> ISO UTC, or null. */
export function hmsTime(raw: unknown): string | null {
  const m = /^(\d{4})(\d{3})\s+(\d{2})(\d{2})$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), 0, Number(m[2]), Number(m[3]), Number(m[4]));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function density(raw: unknown): SmokeDensity {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "light" || v === "medium" || v === "heavy" ? v : "unknown";
}

export function smokeToObservations(payload: unknown, now: Date): SmokeObservation[] {
  const parsed = CollectionSchema.safeParse(payload);
  if (!parsed.success) throw new Error("HMS smoke: unexpected payload shape");
  if (parsed.data.error !== undefined) {
    throw new Error(`HMS smoke: service error ${stableStringify(parsed.data.error)}`);
  }
  if (parsed.data.exceededTransferLimit || parsed.data.properties?.exceededTransferLimit) {
    throw new Error("HMS smoke: response truncated (exceededTransferLimit)");
  }
  const out: SmokeObservation[] = [];
  for (const feature of parsed.data.features ?? []) {
    const props = feature.properties ?? {};
    const start = hmsTime(props.Start);
    const end = hmsTime(props.End_);
    if (!start || !end || new Date(end).getTime() > now.getTime() + 600_000) continue;
    const d = density(props.Density);
    const satellite = String(props.Satellite ?? "satellite").trim();
    const candidate = {
      kind: "smoke" as const,
      observation_id: `hms-smoke:${hashContent(stableStringify([props.Start, props.End_, props.Density, props.Satellite, feature.geometry]))}`,
      name: `${d === "unknown" ? "Smoke" : `${d[0]!.toUpperCase()}${d.slice(1)} smoke`} (${satellite} analysis)`,
      location: { type: "Point" as const, coordinates: [0, 0] as [number, number] },
      observed_at: end,
      last_verified_at: end,
      provider: HMS_PROVIDER,
      provider_tier: "B" as const,
      source_url: HMS_INFO_URL,
      area: feature.geometry,
      density: d,
      starts_at: start,
    };
    const valid = ObservationSchema.safeParse(candidate);
    if (!valid.success || valid.data.kind !== "smoke") continue;
    const obs = valid.data;
    out.push({ ...obs, location: { type: "Point", coordinates: geometryCentroid(obs.area) } });
  }
  return out;
}

export const hmsSmokeConnector: Connector = {
  id: "hms-smoke",
  label: "NOAA HMS satellite smoke analysis",
  source_tier: "B",
  // New analyses appear a few times a day.
  expected_refresh_seconds: 1800,
  zero_rows_expected: true,

  async fetch(now: Date): Promise<ConnectorResult> {
    const retrieved_at = now.toISOString();
    try {
      const payload = await fetchJson(hmsSmokeQueryUrl(), {
        headers: { "User-Agent": FEED_USER_AGENT, Accept: "application/geo+json, application/json" },
        timeoutMs: 20_000,
      });
      const observations = smokeToObservations(payload, now);
      return { ok: true, retrieved_at, events: [], resources: [], source_records: [], observations };
    } catch (err) {
      return { ok: false, retrieved_at, error: errorMessage(err) };
    }
  },
};
