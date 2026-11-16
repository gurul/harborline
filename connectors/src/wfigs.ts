/**
 * Interagency wildfire perimeters and incident points (NIFC WFIGS current
 * layers, keyless ArcGIS FeatureServer, GeoJSON).
 *
 * Both layers are queried with the region box. A mapped perimeter becomes a
 * `fire_perimeter` event with its polygon. An incident with no mapped
 * perimeter becomes a `fire_perimeter` event with a Point: it says where the
 * fire was reported, not how far it reaches, so it never eliminates a route.
 *
 * Severity by percent contained: below 50 percent, or not reported, is
 * `severe` (a severe perimeter eliminates crossing routes and rejects
 * shelters inside it); 50 to 99 percent is `moderate`; 100 percent is skipped.
 * Prescribed fires (`RX`) are `moderate` at most and say so.
 *
 * The "current" layers are a snapshot, so the connector is all-or-nothing:
 * if either query fails or is truncated, the fetch is `ok:false` and nothing
 * is reconciled away.
 */
import { z } from "zod";
import {
  GeometrySchema,
  REGION,
  type CanonicalEvent,
  type Connector,
  type ConnectorResult,
  type Geometry,
  type Severity,
  type SourceRecord,
} from "@harborline/event-schema";
import { pickAttribute } from "./fema.js";
import {
  FEED_USER_AGENT,
  errorMessage,
  fetchJson,
  hashContent,
  makeEvent,
  makeSourceRecord,
  stableStringify,
  toIso,
} from "./util.js";

const SERVICE = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services";
export const WFIGS_PERIMETERS_LAYER = `${SERVICE}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0`;
export const WFIGS_INCIDENTS_LAYER = `${SERVICE}/WFIGS_Incident_Locations_Current/FeatureServer/0`;
export const WFIGS_PROVIDER = "NIFC WFIGS";
/** Public landing page cited as the source. */
export const WFIGS_INFO_URL = "https://data-nifc.opendata.arcgis.com/";

const PAGE_SIZE = 2000;
const MAX_PAGES = 5;

/** Query URL for one layer and one page, scoped to the region box. */
export function wfigsQueryUrl(layer: string, offset = 0): string {
  const [w, s, e, n] = REGION.bbox;
  const params = new URLSearchParams({
    where: "1=1",
    geometry: `${w},${s},${e},${n}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    outSR: "4326",
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: "geojson",
  });
  // About 50 m of simplification: enough for route intersection, and it keeps
  // large perimeters well under the response cap.
  if (layer === WFIGS_PERIMETERS_LAYER) params.set("maxAllowableOffset", "0.0005");
  return `${layer}/query?${params.toString()}`;
}

const FeatureSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).nullish(),
  geometry: z.looseObject({ type: z.string(), coordinates: z.unknown() }).nullish(),
  properties: z.record(z.string(), z.unknown()).nullish(),
});

const CollectionSchema = z.looseObject({
  features: z.array(FeatureSchema).nullish(),
  exceededTransferLimit: z.boolean().nullish(),
  properties: z.looseObject({ exceededTransferLimit: z.boolean().nullish() }).nullish(),
  error: z.unknown().optional(),
});

type Feature = z.infer<typeof FeatureSchema>;

/** Fetch every page of one layer. Throws on an error object or truncation. */
async function fetchLayer(layer: string, label: string): Promise<Feature[]> {
  const out: Feature[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const payload = await fetchJson(wfigsQueryUrl(layer, page * PAGE_SIZE), {
      headers: { "User-Agent": FEED_USER_AGENT, Accept: "application/geo+json, application/json" },
      timeoutMs: 20_000,
    });
    const parsed = CollectionSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`${label}: unexpected payload shape`);
    if (parsed.data.error !== undefined) {
      throw new Error(`${label}: service error ${stableStringify(parsed.data.error)}`);
    }
    const features = parsed.data.features ?? [];
    out.push(...features);
    const more =
      parsed.data.exceededTransferLimit === true ||
      parsed.data.properties?.exceededTransferLimit === true;
    if (!more) return out;
  }
  throw new Error(`${label}: more than ${MAX_PAGES * PAGE_SIZE} features, snapshot incomplete`);
}

function str(attrs: Record<string, unknown>, keys: string[]): string | null {
  const v = pickAttribute(attrs, keys);
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(attrs: Record<string, unknown>, keys: string[]): number | null {
  const v = pickAttribute(attrs, keys);
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** IRWIN ids arrive as "{9C76...}" on one layer and bare on another. */
export function normalizeIrwinId(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.replace(/[{}]/g, "").trim().toLowerCase();
  return s === "" ? null : s;
}

export interface ContainmentSeverity {
  severity: Severity;
  phrase: string;
}

/**
 * Severity from percent contained. Returns null for a fully contained fire,
 * which is not reported. A missing value is treated as uncontained: an absent
 * figure is not evidence that a fire is held.
 */
export function containmentSeverity(
  percent: number | null,
  category: string | null,
): ContainmentSeverity | null {
  if (percent !== null && percent >= 100) return null;
  const phrase = percent === null ? "containment not reported" : `${Math.round(percent)}% contained`;
  if ((category ?? "").toUpperCase() === "RX") {
    return { severity: "moderate", phrase: `prescribed fire, ${phrase}` };
  }
  if (percent === null || percent < 50) return { severity: "severe", phrase };
  return { severity: "moderate", phrase };
}

const NAME_KEYS = ["poly_IncidentName", "attr_IncidentName", "IncidentName"];
const PERCENT_KEYS = ["attr_PercentContained", "PercentContained"];
const CATEGORY_KEYS = ["attr_IncidentTypeCategory", "IncidentTypeCategory"];
const IRWIN_KEYS = ["poly_IRWINID", "attr_IrwinID", "IrwinID"];
const UNIQUE_KEYS = ["attr_UniqueFireIdentifier", "UniqueFireIdentifier"];
const ACRES_KEYS = ["poly_GISAcres", "attr_IncidentSize", "IncidentSize"];

function fireId(attrs: Record<string, unknown>, feature: Feature): string {
  return (
    normalizeIrwinId(str(attrs, IRWIN_KEYS)) ??
    str(attrs, UNIQUE_KEYS)?.toLowerCase() ??
    hashContent(stableStringify(feature))
  );
}

function acresPhrase(acres: number | null): string {
  return acres === null ? "size not reported" : `${Math.round(acres).toLocaleString("en-US")} acres`;
}

interface Built {
  event: CanonicalEvent;
  record: SourceRecord;
}

function build(
  feature: Feature,
  kind: "perimeter" | "incident",
  geometry: Geometry,
  now: Date,
  retrievedAt: string,
): Built | null {
  const attrs = feature.properties ?? {};
  const percent = num(attrs, PERCENT_KEYS);
  const category = str(attrs, CATEGORY_KEYS);
  const rating = containmentSeverity(percent, category);
  if (!rating) return null;

  const name = str(attrs, NAME_KEYS) ?? "Unnamed";
  const id = `wfigs:${fireId(attrs, feature)}`;
  const timeKeys = kind === "perimeter"
    ? ["poly_DateCurrent", "attr_ModifiedOnDateTime_dt", "poly_PolygonDateTime"]
    : ["ModifiedOnDateTime_dt", "FireDiscoveryDateTime"];
  const lastVerified = toIso(pickAttribute(attrs, timeKeys)) ?? retrievedAt;
  const discovered = toIso(pickAttribute(attrs, ["attr_FireDiscoveryDateTime", "FireDiscoveryDateTime"]));
  const acres = num(attrs, ACRES_KEYS);

  const headline = kind === "perimeter"
    ? `${name} fire perimeter (${rating.phrase})`
    : `${name} wildfire incident, location only (${rating.phrase})`;
  const description = kind === "perimeter"
    ? `Mapped interagency wildfire perimeter, ${acresPhrase(acres)}, ${rating.phrase}. ` +
      `A perimeter is redrawn about once a day and can be behind the fire front.`
    : `Interagency wildfire incident report, ${acresPhrase(acres)}, ${rating.phrase}. ` +
      `No perimeter is mapped yet; the point marks where the fire was reported, not its extent.`;

  const event = makeEvent(
    {
      event_id: id,
      event_type: "fire_perimeter",
      headline,
      description,
      instructions: null,
      severity: rating.severity,
      urgency: "unknown",
      certainty: "observed",
      status: "active",
      geometry,
      starts_at: discovered,
      ends_at: null,
      last_verified_at: lastVerified,
      best_tier: "B",
      source_count: 1,
      geographic_precision: kind === "perimeter" ? 1 : 0.5,
    },
    now,
  );
  const record = makeSourceRecord({
    source_record_id: `wfigs-record:${kind}:${id}`,
    event_id: id,
    provider: WFIGS_PROVIDER,
    provider_record_id: str(attrs, UNIQUE_KEYS) ?? str(attrs, IRWIN_KEYS),
    provider_tier: "B",
    source_url: WFIGS_INFO_URL,
    published_at: lastVerified,
    retrieved_at: retrievedAt,
    hash_input: stableStringify({ p: feature.properties, g: feature.geometry }),
  });
  return { event, record };
}

/** Pure normalization of the two layers' features. */
export function wfigsToEvents(
  perimeters: Feature[],
  incidents: Feature[],
  now: Date,
  retrievedAt: string,
): { events: CanonicalEvent[]; source_records: SourceRecord[]; dropped: number } {
  const events: CanonicalEvent[] = [];
  const source_records: SourceRecord[] = [];
  const mapped = new Set<string>();
  let dropped = 0;

  for (const feature of perimeters) {
    const attrs = feature.properties ?? {};
    const geom = GeometrySchema.safeParse(feature.geometry);
    // Unclosed rings, out-of-range coordinates and non-area shapes are
    // dropped: a malformed polygon silently fails to eliminate a route.
    if (!geom.success || (geom.data.type !== "Polygon" && geom.data.type !== "MultiPolygon")) {
      dropped++;
      continue;
    }
    mapped.add(fireId(attrs, feature));
    const built = build(feature, "perimeter", geom.data, now, retrievedAt);
    if (built) {
      events.push(built.event);
      source_records.push(built.record);
    }
  }

  for (const feature of incidents) {
    const attrs = feature.properties ?? {};
    if (mapped.has(fireId(attrs, feature))) continue;
    const geom = GeometrySchema.safeParse(feature.geometry);
    if (!geom.success || geom.data.type !== "Point") {
      dropped++;
      continue;
    }
    const built = build(feature, "incident", geom.data, now, retrievedAt);
    if (built) {
      events.push(built.event);
      source_records.push(built.record);
    }
  }

  return { events, source_records, dropped };
}

export const wfigsConnector: Connector = {
  id: "nifc-wfigs",
  label: "NIFC WFIGS current wildfire perimeters and incidents",
  source_tier: "B",
  expected_refresh_seconds: 1800,
  // Outside fire season the region often has no current fire.
  zero_rows_expected: true,

  async fetch(now: Date): Promise<ConnectorResult> {
    const retrieved_at = now.toISOString();
    try {
      const [perimeters, incidents] = await Promise.all([
        fetchLayer(WFIGS_PERIMETERS_LAYER, "WFIGS perimeters"),
        fetchLayer(WFIGS_INCIDENTS_LAYER, "WFIGS incidents"),
      ]);
      const { events, source_records } = wfigsToEvents(perimeters, incidents, now, retrieved_at);
      return { ok: true, retrieved_at, events, resources: [], source_records };
    } catch (err) {
      return { ok: false, retrieved_at, error: errorMessage(err) };
    }
  },
};
