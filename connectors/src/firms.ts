/**
 * Satellite active-fire detections: the keyless NASA FIRMS 24-hour VIIRS files
 * for NOAA-20 and NOAA-21.
 *
 * The files cover the contiguous US and Hawaii and carry no area filter, so the
 * connector downloads both (about 80 KB each) and keeps the rows inside
 * `REGION.bbox`. Suomi NPP is not read: it stopped delivering data.
 *
 * Safety model (see docs/ARCHITECTURE.md §8):
 *   - One `fire_detection` event per cluster of nearby pixels, tier C.
 *   - Geometry is one rectangle per pixel, sized from the `scan`/`track`
 *     columns plus a fixed position-error margin, so the map and the router
 *     see the same footprint.
 *   - Severity: `minor` when every pixel is low confidence (or the cluster
 *     sits on a known industrial heat source); `severe` only when two separate
 *     passes or sensors within 12 h saw it and at least one pixel is nominal or
 *     high; `moderate` otherwise. Never `extreme`.
 *   - `ends_at` = newest pixel + 24 h, so a zero-row fetch and the store's
 *     retention end a cluster at the same time.
 *
 * Both files are one snapshot: if either request fails the whole fetch is
 * `ok:false`, so reconciliation never expires one satellite's clusters because
 * the other satellite's file was missing. Zero rows in the region is a normal,
 * successful result.
 */
import {
  REGION,
  bboxContains,
  haversineMeters,
  type CanonicalEvent,
  type Connector,
  type ConnectorResult,
  type LonLat,
  type Severity,
  type SourceRecord,
  type StaticHeatSource,
} from "@harborline/event-schema";
import {
  FEED_USER_AGENT,
  errorMessage,
  fetchText,
  hashContent,
  makeEvent,
  makeSourceRecord,
} from "./util.js";

export interface FirmsFile {
  key: "noaa20" | "noaa21";
  label: string;
  url: string;
}

export const FIRMS_FILES: FirmsFile[] = [
  {
    key: "noaa20",
    label: "NOAA-20",
    url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv",
  },
  {
    key: "noaa21",
    label: "NOAA-21",
    url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv",
  },
];

/** Public page that describes the files; cited as the source URL. */
export const FIRMS_INFO_URL = "https://firms.modaps.eosdis.nasa.gov/active_fire/";
export const FIRMS_PROVIDER = "NASA FIRMS (VIIRS)";

/** Pixels older than this are outside the feed's window and are dropped. */
export const DETECTION_WINDOW_MS = 24 * 3600_000;
/** Position-error margin added on every side of a pixel footprint, metres. */
export const FOOTPRINT_MARGIN_M = 100;
/** Two passes within this window confirm a cluster. */
export const CONFIRMATION_WINDOW_MS = 12 * 3600_000;
/** Upper bound on region rows clustered per fetch (clustering is O(n^2)). */
export const MAX_REGION_ROWS = 5000;

const REQUIRED_COLUMNS = [
  "latitude",
  "longitude",
  "scan",
  "track",
  "acq_date",
  "acq_time",
  "satellite",
  "confidence",
  "frp",
  "daynight",
] as const;

export type DetectionConfidence = "low" | "nominal" | "high";

export interface FirmsDetection {
  lat: number;
  lon: number;
  /** Pixel size along scan and along track, kilometres. */
  scan_km: number;
  track_km: number;
  /** Acquisition time, ISO UTC. */
  observed_at: string;
  satellite: string;
  confidence: DetectionConfidence;
  frp_mw: number | null;
  daynight: string;
}

export type FirmsParseResult =
  | { ok: true; rows: FirmsDetection[]; skipped: number }
  | { ok: false; error: string };

function mapConfidence(raw: string): DetectionConfidence | null {
  const v = raw.trim().toLowerCase();
  if (v === "l" || v === "low") return "low";
  if (v === "n" || v === "nominal") return "nominal";
  if (v === "h" || v === "high") return "high";
  // MODIS-style numeric confidence, in case a numeric file is ever read.
  const n = Number(v);
  if (v !== "" && Number.isFinite(n)) return n < 30 ? "low" : n < 80 ? "nominal" : "high";
  return null;
}

/**
 * Parse a FIRMS active-fire CSV. A body whose first line is not the expected
 * header (an HTML error page, an "Invalid" message) is an error. A header with
 * no rows is a valid empty result.
 */
export function parseFirmsCsv(text: string): FirmsParseResult {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { ok: false, error: "FIRMS file is empty (no header row)" };
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return { ok: false, error: `not a FIRMS active-fire CSV (missing columns: ${missing.join(", ")})` };
  }
  const col = Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<
    (typeof REQUIRED_COLUMNS)[number],
    number
  >;

  const rows: FirmsDetection[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    const lat = Number(f[col.latitude]);
    const lon = Number(f[col.longitude]);
    const scan = Number(f[col.scan]);
    const track = Number(f[col.track]);
    const date = (f[col.acq_date] ?? "").trim();
    const time = (f[col.acq_time] ?? "").trim().padStart(4, "0");
    const confidence = mapConfidence(f[col.confidence] ?? "");
    const observed = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{4}$/.test(time)
      ? new Date(`${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`)
      : null;
    if (
      !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lon) || lon < -180 || lon > 180 ||
      !Number.isFinite(scan) || scan <= 0 || !Number.isFinite(track) || track <= 0 ||
      confidence === null || observed === null || Number.isNaN(observed.getTime())
    ) {
      skipped++;
      continue;
    }
    const frp = Number(f[col.frp]);
    rows.push({
      lat,
      lon,
      scan_km: scan,
      track_km: track,
      observed_at: observed.toISOString(),
      satellite: (f[col.satellite] ?? "").trim(),
      confidence,
      frp_mw: Number.isFinite(frp) ? frp : null,
      daynight: (f[col.daynight] ?? "").trim(),
    });
  }
  return { ok: true, rows, skipped };
}

function diagonalM(d: FirmsDetection): number {
  return Math.hypot(d.scan_km, d.track_km) * 1000;
}

function passKey(d: FirmsDetection): string {
  return `${d.satellite}|${d.observed_at}`;
}

/**
 * Single-linkage clustering: two pixels join when their centres are closer
 * than the larger pixel diagonal of the pair. Order of the output and of the
 * members is deterministic.
 */
export function clusterDetections(rows: FirmsDetection[]): FirmsDetection[][] {
  const sorted = [...rows].sort(
    (a, b) =>
      a.observed_at.localeCompare(b.observed_at) || a.lat - b.lat || a.lon - b.lon ||
      a.satellite.localeCompare(b.satellite),
  );
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      // Cheap reject before the haversine: 0.05 deg is ~4-5 km.
      if (Math.abs(a.lat - b.lat) > 0.05 || Math.abs(a.lon - b.lon) > 0.07) continue;
      const limit = Math.max(diagonalM(a), diagonalM(b));
      if (haversineMeters([a.lon, a.lat], [b.lon, b.lat]) < limit) {
        const ra = find(i);
        const rb = find(j);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
  }
  const groups = new Map<number, FirmsDetection[]>();
  sorted.forEach((row, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(row);
    else groups.set(root, [row]);
  });
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, members]) => members);
}

/** Rectangle around a pixel centre: half the pixel size plus the margin per side. */
function footprint(d: FirmsDetection): LonLat[][] {
  const halfX = (d.scan_km * 1000) / 2 + FOOTPRINT_MARGIN_M;
  const halfY = (d.track_km * 1000) / 2 + FOOTPRINT_MARGIN_M;
  const dLat = halfY / 111_320;
  const dLon = halfX / (111_320 * Math.cos((d.lat * Math.PI) / 180));
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  const w = r(d.lon - dLon);
  const e = r(d.lon + dLon);
  const s = r(d.lat - dLat);
  const n = r(d.lat + dLat);
  return [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
}

export interface ClusterSeverity {
  severity: Severity;
  reason: string;
}

/** Severity rule for one cluster. See the module header. */
export function clusterSeverity(
  members: FirmsDetection[],
  staticHeatSources: StaticHeatSource[] = [],
): ClusterSeverity {
  const center = clusterCenter(members);
  const site = staticHeatSources.find((s) => haversineMeters(center, s.center) <= s.radius_m);
  if (site) {
    return { severity: "minor", reason: `It matches a known permanent heat source (${site.name}).` };
  }
  const confident = members.filter((m) => m.confidence !== "low");
  if (confident.length === 0) {
    return { severity: "minor", reason: "Every pixel is low confidence." };
  }
  if (twoPassesWithin(members, CONFIRMATION_WINDOW_MS)) {
    return { severity: "severe", reason: "Seen on two or more separate satellite passes within 12 h." };
  }
  return { severity: "moderate", reason: "Seen on one satellite pass only." };
}

/**
 * One overpass of one satellite spans several minutes and is cut into
 * 6-minute granules, so its pixels can carry acquisition times a few minutes
 * apart. Two observations are separate passes when they come from different
 * satellites, or from the same satellite more than this far apart (an orbit
 * takes about 100 min).
 */
export const SAME_PASS_TOLERANCE_MS = 30 * 60_000;

function twoPassesWithin(members: FirmsDetection[], windowMs: number): boolean {
  const obs = [...new Set(members.map(passKey))].map((k) => {
    const [satellite, at] = k.split("|");
    return { satellite: satellite!, t: new Date(at!).getTime() };
  });
  for (let i = 0; i < obs.length; i++) {
    for (let j = i + 1; j < obs.length; j++) {
      const a = obs[i]!;
      const b = obs[j]!;
      const gap = Math.abs(a.t - b.t);
      if (gap > windowMs) continue;
      if (a.satellite !== b.satellite || gap > SAME_PASS_TOLERANCE_MS) return true;
    }
  }
  return false;
}

function countPasses(members: FirmsDetection[]): number {
  const bySat = new Map<string, number[]>();
  for (const m of members) {
    const list = bySat.get(m.satellite) ?? [];
    list.push(new Date(m.observed_at).getTime());
    bySat.set(m.satellite, list);
  }
  let count = 0;
  for (const times of bySat.values()) {
    times.sort((a, b) => a - b);
    let last = Number.NEGATIVE_INFINITY;
    for (const t of times) {
      if (t - last > SAME_PASS_TOLERANCE_MS) count++;
      last = t;
    }
  }
  return count;
}

function clusterCenter(members: FirmsDetection[]): LonLat {
  const lon = members.reduce((s, m) => s + m.lon, 0) / members.length;
  const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
  return [lon, lat];
}

const SATELLITE_NAME: Record<string, string> = { N20: "NOAA-20", N21: "NOAA-21", N: "Suomi NPP" };

function utcLabel(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export interface DetectionItems {
  events: CanonicalEvent[];
  source_records: SourceRecord[];
}

/**
 * Turn region-filtered detections into one event and one source record per
 * cluster. Pure: `now` and `retrievedAt` come from the caller.
 */
export function detectionsToEvents(
  rows: FirmsDetection[],
  now: Date,
  retrievedAt: string,
  opts: { staticHeatSources?: StaticHeatSource[] } = {},
): DetectionItems {
  const events: CanonicalEvent[] = [];
  const source_records: SourceRecord[] = [];

  for (const members of clusterDetections(rows)) {
    const earliest = members[0]!;
    const newest = members.reduce((a, b) => (b.observed_at > a.observed_at ? b : a));
    const eventId = `firms:${hashContent(
      `${earliest.satellite}|${earliest.observed_at}|${earliest.lat}|${earliest.lon}`,
    )}`;
    const { severity, reason } = clusterSeverity(members, opts.staticHeatSources);
    const [lon, lat] = clusterCenter(members);
    const sats = [...new Set(members.map((m) => SATELLITE_NAME[m.satellite] ?? m.satellite))].sort();
    const passes = countPasses(members);
    const n = members.length;
    const endsAt = new Date(new Date(newest.observed_at).getTime() + DETECTION_WINDOW_MS).toISOString();

    events.push(
      makeEvent(
        {
          event_id: eventId,
          event_type: "fire_detection",
          headline: `Satellite heat detection near ${lat.toFixed(3)}, ${lon.toFixed(3)} (${n} pixel${n === 1 ? "" : "s"}, unconfirmed)`,
          description:
            `${n} VIIRS heat detection${n === 1 ? "" : "s"} from ${sats.join(" and ")} ` +
            `on ${passes} pass${passes === 1 ? "" : "es"}, newest at ${utcLabel(newest.observed_at)}. ` +
            `${reason} Not confirmed by a fire agency. Satellites pass a few times a day, ` +
            `and cloud or smoke can hide a fire.`,
          instructions: null,
          severity,
          urgency: "unknown",
          certainty: members.some((m) => m.confidence !== "low") ? "likely" : "possible",
          status: "active",
          geometry: { type: "MultiPolygon", coordinates: members.map(footprint) },
          starts_at: earliest.observed_at,
          ends_at: endsAt,
          last_verified_at: newest.observed_at,
          best_tier: "C",
          source_count: 1,
          geographic_precision: 0.8,
        },
        now,
      ),
    );

    const payload = members.slice(0, 50).map((m) => ({
      satellite: m.satellite,
      observed_at: m.observed_at,
      lat: m.lat,
      lon: m.lon,
      scan_km: m.scan_km,
      track_km: m.track_km,
      confidence: m.confidence,
      frp_mw: m.frp_mw,
    }));
    source_records.push(
      makeSourceRecord({
        source_record_id: `firms-record:${eventId}`,
        event_id: eventId,
        provider: FIRMS_PROVIDER,
        provider_record_id: null,
        provider_tier: "C",
        source_url: FIRMS_INFO_URL,
        published_at: newest.observed_at,
        retrieved_at: retrievedAt,
        raw_payload: { pixel_count: n, members: payload },
        hash_input: JSON.stringify(payload),
      }),
    );
  }

  return { events, source_records };
}

/** Keep rows inside the region box and inside the 24 h window ending at `now`. */
export function regionRows(rows: FirmsDetection[], now: Date): FirmsDetection[] {
  const nowMs = now.getTime();
  return rows.filter((r) => {
    if (!bboxContains(REGION.bbox, [r.lon, r.lat])) return false;
    const t = new Date(r.observed_at).getTime();
    // 10 min of forward skew is tolerated, as everywhere else.
    return t >= nowMs - DETECTION_WINDOW_MS && t <= nowMs + 600_000;
  });
}

export const firmsConnector: Connector = {
  id: "firms-viirs",
  label: "NASA FIRMS VIIRS active fire, NOAA-20 and NOAA-21 (last 24 h)",
  source_tier: "C",
  // The rate limits and terms of the keyless files are not confirmed, so the
  // poll is slow. The files are rewritten every few minutes, but new pixels
  // arrive only a few times a day.
  expected_refresh_seconds: 1800,
  zero_rows_expected: true,

  async fetch(now: Date): Promise<ConnectorResult> {
    const retrieved_at = now.toISOString();
    try {
      const bodies = await Promise.all(
        FIRMS_FILES.map(async (file) => {
          try {
            return {
              file,
              text: await fetchText(file.url, {
                headers: { "User-Agent": FEED_USER_AGENT, Accept: "text/csv, text/plain" },
                timeoutMs: 20_000,
              }),
            };
          } catch (err) {
            throw new Error(`${file.label} file: ${errorMessage(err)}`);
          }
        }),
      );

      const rows: FirmsDetection[] = [];
      for (const { file, text } of bodies) {
        const parsed = parseFirmsCsv(text);
        if (!parsed.ok) {
          return { ok: false, retrieved_at, error: `${file.label} file: ${parsed.error}` };
        }
        rows.push(...regionRows(parsed.rows, now));
      }
      if (rows.length > MAX_REGION_ROWS) {
        return {
          ok: false,
          retrieved_at,
          error: `FIRMS: ${rows.length} region rows exceed the ${MAX_REGION_ROWS} row cap`,
        };
      }

      const { events, source_records } = detectionsToEvents(rows, now, retrieved_at, {
        staticHeatSources: REGION.staticHeatSources,
      });
      return { ok: true, retrieved_at, events, resources: [], source_records };
    } catch (err) {
      return { ok: false, retrieved_at, error: errorMessage(err) };
    }
  },
};
