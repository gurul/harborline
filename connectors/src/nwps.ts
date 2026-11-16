/**
 * River gauges: NOAA National Water Prediction Service (NWPS), keyless JSON.
 *
 * One request lists every gauge in the region box with its latest observed
 * stage and the official NWS flood category, observed and forecast. A gauge
 * is an observation, not a flood area: it never blocks a road or rejects a
 * shelter. NWS flood warnings keep driving routing through the alert feed.
 *
 * Pitfalls seen in the live response (2026-11-16): missing numbers are -999,
 * an absent forecast has validTime "0001-01-01T00:00:00Z", and categories
 * include `not_defined`, `obs_not_current`, `fcst_not_current` and
 * `out_of_service`. Every value the service cannot rate maps to `unknown`;
 * none of them is read as "no flooding".
 */
import { z } from "zod";
import {
  ObservationSchema,
  REGION,
  type Connector,
  type ConnectorResult,
  type FloodCategory,
  type StreamGaugeObservation,
} from "@harborline/event-schema";
import { FEED_USER_AGENT, errorMessage, fetchJson } from "./util.js";

export const NWPS_PROVIDER = "NOAA NWPS";

export function nwpsGaugesUrl(): string {
  const [w, s, e, n] = REGION.bbox;
  return (
    "https://api.water.noaa.gov/nwps/v1/gauges" +
    `?bbox.xmin=${w}&bbox.ymin=${s}&bbox.xmax=${e}&bbox.ymax=${n}&srid=EPSG_4326`
  );
}

const ReadingSchema = z.looseObject({
  primary: z.number().nullish(),
  primaryUnit: z.string().nullish(),
  secondary: z.number().nullish(),
  secondaryUnit: z.string().nullish(),
  floodCategory: z.string().nullish(),
  validTime: z.string().nullish(),
});

const GaugeSchema = z.looseObject({
  lid: z.string(),
  name: z.string().nullish(),
  latitude: z.number(),
  longitude: z.number(),
  status: z.looseObject({
    observed: ReadingSchema.nullish(),
    forecast: ReadingSchema.nullish(),
  }).nullish(),
});

const ResponseSchema = z.looseObject({ gauges: z.array(z.unknown()) });

const RATED: ReadonlySet<string> = new Set(["no_flooding", "action", "minor", "moderate", "major"]);

export function mapFloodCategory(raw: string | null | undefined): FloodCategory {
  const v = (raw ?? "").trim().toLowerCase();
  return RATED.has(v) ? (v as FloodCategory) : "unknown";
}

/** -999 and other sentinels are missing values. */
function value(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > -900 ? n : null;
}

function validTime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000) return null;
  return d.toISOString();
}

export function gaugesToObservations(payload: unknown, now: Date): StreamGaugeObservation[] {
  const parsed = ResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("NWPS: unexpected payload shape (no gauges array)");
  const out: StreamGaugeObservation[] = [];
  for (const raw of parsed.data.gauges) {
    const g = GaugeSchema.safeParse(raw);
    if (!g.success) continue;
    const gauge = g.data;
    const observed = gauge.status?.observed;
    if ((observed?.floodCategory ?? "").toLowerCase() === "out_of_service") continue;
    const at = validTime(observed?.validTime);
    if (!at || new Date(at).getTime() > now.getTime() + 600_000) continue;

    const primary = value(observed?.primary);
    const secondary = value(observed?.secondary);
    const primaryUnit = (observed?.primaryUnit ?? "").toLowerCase();
    const secondaryUnit = (observed?.secondaryUnit ?? "").toLowerCase();
    const stage = primaryUnit === "ft" ? primary : null;
    const flow =
      primaryUnit === "kcfs" && primary !== null
        ? primary * 1000
        : secondaryUnit === "kcfs" && secondary !== null
          ? secondary * 1000
          : null;
    const forecastRaw = gauge.status?.forecast?.floodCategory;
    const forecast = RATED.has((forecastRaw ?? "").toLowerCase()) ? mapFloodCategory(forecastRaw) : null;

    const candidate: StreamGaugeObservation = {
      kind: "stream_gauge",
      observation_id: `nwps:${gauge.lid.toLowerCase()}`,
      name: (gauge.name ?? gauge.lid).replace(/\s+/g, " ").trim(),
      location: { type: "Point", coordinates: [gauge.longitude, gauge.latitude] },
      observed_at: at,
      last_verified_at: at,
      provider: NWPS_PROVIDER,
      provider_tier: "A",
      source_url: `https://water.noaa.gov/gauges/${encodeURIComponent(gauge.lid.toLowerCase())}`,
      site_id: gauge.lid,
      stage_ft: stage,
      flow_cfs: flow,
      flood_category: mapFloodCategory(observed?.floodCategory),
      forecast_category: forecast,
    };
    const valid = ObservationSchema.safeParse(candidate);
    if (valid.success && valid.data.kind === "stream_gauge") out.push(valid.data);
  }
  return out;
}

export const nwpsConnector: Connector = {
  id: "nwps-gauges",
  label: "NOAA NWPS river gauges with flood categories",
  source_tier: "A",
  // Gauges report every 15 to 60 minutes. Rate limits are not published, so
  // the region list (about 1 MB) is read every 15 minutes at most.
  expected_refresh_seconds: 900,

  async fetch(now: Date): Promise<ConnectorResult> {
    const retrieved_at = now.toISOString();
    try {
      const payload = await fetchJson(nwpsGaugesUrl(), {
        headers: { "User-Agent": FEED_USER_AGENT, Accept: "application/json" },
        timeoutMs: 20_000,
      });
      const observations = gaugesToObservations(payload, now);
      return { ok: true, retrieved_at, events: [], resources: [], source_records: [], observations };
    } catch (err) {
      return { ok: false, retrieved_at, error: errorMessage(err) };
    }
  },
};
