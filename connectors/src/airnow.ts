/**
 * Air quality: the keyless AirNow reporting-area file.
 *
 * `reportingarea.dat` is one of the AirNow hourly data files. It is
 * pipe-delimited with no header, rewritten every hour, and carries for each
 * reporting area the AQI value and EPA category that the reporting agency
 * computed, plus forecasts. Only observation rows (`O`) are read. Using the
 * agency AQI avoids converting raw hourly concentrations, which is not the
 * NowCast method agencies publish.
 *
 * Columns, as observed on 2026-11-16 (17 per row):
 *   0 issue date | 1 valid date (MM/DD/YY) | 2 valid time (H:MM, local) |
 *   3 time zone | 4 record sequence | 5 data type (F/Y/O) | 6 primary (Y/N) |
 *   7 reporting area | 8 state | 9 latitude | 10 longitude | 11 parameter |
 *   12 AQI | 13 category | 14 action day | 15 discussion | 16 agency
 *
 * The time zone column names local standard zones (PST, MST, CST, EST...).
 * Whether daylight-saving hours are written as daylight zones is not
 * confirmed; an unknown zone is skipped and a reading dated in the future is
 * dropped, so a wrong guess can only make a reading look older, never newer.
 */
import {
  AqiCategorySchema,
  ObservationSchema,
  REGION,
  aqiCategory,
  bboxContains,
  type AirQualityObservation,
  type AqiCategory,
  type Connector,
  type ConnectorResult,
  type LonLat,
} from "@harborline/event-schema";
import { FEED_USER_AGENT, errorMessage, fetchText } from "./util.js";

export const AIRNOW_REPORTING_AREA_URL =
  "https://files.airnowtech.org/airnow/today/reportingarea.dat";
export const AIRNOW_PROVIDER = "AirNow (EPA and partner agencies)";
export const AIRNOW_INFO_URL = "https://www.airnow.gov/";

/** UTC offsets, hours, for the zone names the file uses. Others are skipped. */
const ZONE_OFFSET_HOURS: Record<string, number> = {
  EST: -5,
  EDT: -4,
  CST: -6,
  CDT: -5,
  MST: -7,
  MDT: -6,
  AZT: -7,
  PST: -8,
  PDT: -7,
  AKST: -9,
  AKDT: -8,
  HST: -10,
  AST: -4,
};

export interface ReportingAreaRow {
  area: string;
  state: string;
  lat: number;
  lon: number;
  parameter: string;
  aqi: number;
  category: string;
  primary: boolean;
  agency: string;
  observed_at: string;
}

export type ReportingAreaParse =
  | { ok: true; rows: ReportingAreaRow[]; lines: number }
  | { ok: false; error: string };

function toUtc(date: string, time: string, zone: string): string | null {
  const offset = ZONE_OFFSET_HOURS[zone.trim().toUpperCase()];
  if (offset === undefined) return null;
  const d = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!d || !t) return null;
  const ms = Date.UTC(2000 + Number(d[3]), Number(d[1]) - 1, Number(d[2]), Number(t[1]) - offset, Number(t[2]));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Parse the observation rows. A body with no 17-field line is not the file. */
export function parseReportingArea(text: string): ReportingAreaParse {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const shaped = lines.filter((l) => l.split("|").length === 17);
  if (shaped.length === 0) {
    return { ok: false, error: "not an AirNow reporting-area file (no 17-field rows)" };
  }
  const rows: ReportingAreaRow[] = [];
  for (const line of shaped) {
    const f = line.split("|");
    if (f[5] !== "O") continue;
    const observed = toUtc(f[1]!, f[2]!, f[3]!);
    const lat = Number(f[9]);
    const lon = Number(f[10]);
    const aqi = Number(f[12]);
    if (!observed || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isInteger(aqi) || aqi < 0) {
      continue;
    }
    rows.push({
      area: f[7]!.trim(),
      state: f[8]!.trim(),
      lat,
      lon,
      parameter: f[11]!.trim(),
      aqi,
      category: f[13]!.trim(),
      primary: f[6]!.trim().toUpperCase() === "Y",
      agency: f[16]!.trim(),
      observed_at: observed,
    });
  }
  return { ok: true, rows, lines: shaped.length };
}

/**
 * One observation per reporting area in the region: the newest hour, and in
 * that hour the pollutant the file marks primary (else the highest AQI).
 */
export function reportingAreaToObservations(
  rows: ReportingAreaRow[],
  now: Date,
): AirQualityObservation[] {
  const byArea = new Map<string, ReportingAreaRow[]>();
  for (const row of rows) {
    const at: LonLat = [row.lon, row.lat];
    if (!bboxContains(REGION.bbox, at)) continue;
    if (new Date(row.observed_at).getTime() > now.getTime() + 600_000) continue;
    const key = `${row.state}|${row.area}`;
    const list = byArea.get(key) ?? [];
    list.push(row);
    byArea.set(key, list);
  }

  const out: AirQualityObservation[] = [];
  for (const [key, list] of byArea) {
    const newestTime = list.reduce((a, b) => (b.observed_at > a ? b.observed_at : a), list[0]!.observed_at);
    const hour = list.filter((r) => r.observed_at === newestTime);
    const chosen =
      hour.find((r) => r.primary) ?? hour.reduce((a, b) => (b.aqi > a.aqi ? b : a));
    const parsedCategory = AqiCategorySchema.safeParse(chosen.category);
    const category: AqiCategory = parsedCategory.success && parsedCategory.data !== "Unknown"
      ? parsedCategory.data
      : aqiCategory(chosen.aqi);
    const candidate: AirQualityObservation = {
      kind: "air_quality",
      observation_id: `airnow:${key.toLowerCase().replace(/[^a-z0-9|]+/g, "-")}`,
      name: `${chosen.area}, ${chosen.state}`,
      location: { type: "Point", coordinates: [chosen.lon, chosen.lat] },
      observed_at: chosen.observed_at,
      last_verified_at: chosen.observed_at,
      provider: chosen.agency ? `${AIRNOW_PROVIDER}; ${chosen.agency}` : AIRNOW_PROVIDER,
      provider_tier: "B",
      source_url: AIRNOW_INFO_URL,
      aqi: chosen.aqi,
      category,
      pollutant: chosen.parameter,
    };
    const valid = ObservationSchema.safeParse(candidate);
    if (valid.success && valid.data.kind === "air_quality") out.push(valid.data);
  }
  return out.sort((a, b) => a.observation_id.localeCompare(b.observation_id));
}

export const airnowConnector: Connector = {
  id: "airnow-files",
  label: "AirNow reporting-area air quality (keyless hourly file)",
  source_tier: "B",
  // The file is rewritten hourly. Terms and rate limits for the file server
  // are not confirmed, so the poll stays slow.
  expected_refresh_seconds: 1800,

  async fetch(now: Date): Promise<ConnectorResult> {
    const retrieved_at = now.toISOString();
    try {
      const text = await fetchText(AIRNOW_REPORTING_AREA_URL, {
        headers: { "User-Agent": FEED_USER_AGENT, Accept: "text/plain" },
        timeoutMs: 20_000,
      });
      const parsed = parseReportingArea(text);
      if (!parsed.ok) return { ok: false, retrieved_at, error: `AirNow: ${parsed.error}` };
      const observations = reportingAreaToObservations(parsed.rows, now);
      return { ok: true, retrieved_at, events: [], resources: [], source_records: [], observations };
    } catch (err) {
      return { ok: false, retrieved_at, error: errorMessage(err) };
    }
  },
};
