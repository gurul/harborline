import { z } from "zod";
import {
  GeometrySchema,
  REGION,
  type CanonicalEvent,
  type Certainty,
  type Connector,
  type ConnectorResult,
  type EventType,
  type MultiPolygon,
  type Polygon,
  type Severity,
  type SourceRecord,
  type Urgency,
} from "@harborline/event-schema";
import {
  errorMessage,
  fetchJson,
  hashContent,
  makeEvent,
  makeSourceRecord,
  stableStringify,
  toIso,
} from "./util.js";

export const NWS_ALERTS_URL = `https://api.weather.gov/alerts/active?area=${REGION.nwsArea}`;

const USER_AGENT = "harborline (https://github.com/gurul/harborline)";

/**
 * Loose upstream validation: we assert only the fields we read and let every
 * other CAP field pass through untouched (upstream adds fields regularly and a
 * strict schema would take the whole feed down).
 */
const NwsPropertiesSchema = z.looseObject({
  id: z.string().optional(),
  event: z.string().optional(),
  headline: z.string().nullish(),
  description: z.string().nullish(),
  instruction: z.string().nullish(),
  severity: z.string().nullish(),
  urgency: z.string().nullish(),
  certainty: z.string().nullish(),
  onset: z.string().nullish(),
  effective: z.string().nullish(),
  ends: z.string().nullish(),
  expires: z.string().nullish(),
  sent: z.string().nullish(),
  areaDesc: z.string().nullish(),
  affectedZones: z.array(z.string()).nullish(),
});

const NwsFeatureSchema = z.looseObject({
  id: z.string().optional(),
  geometry: z.unknown().nullish(),
  properties: NwsPropertiesSchema,
});

const NwsFeatureCollectionSchema = z.looseObject({
  features: z.array(NwsFeatureSchema).default([]),
});

const SEVERITIES: Severity[] = ["minor", "moderate", "severe", "extreme"];
const URGENCIES: Urgency[] = ["immediate", "expected", "future", "past", "unknown"];
const CERTAINTIES: Certainty[] = [
  "observed",
  "likely",
  "possible",
  "unlikely",
  "unknown",
];

/** CAP Severity → canonical severity. "Unknown"/absent falls back to moderate. */
export function mapSeverity(raw: string | null | undefined): Severity {
  const v = (raw ?? "").trim().toLowerCase();
  return (SEVERITIES as string[]).includes(v) ? (v as Severity) : "moderate";
}

export function mapUrgency(raw: string | null | undefined): Urgency {
  const v = (raw ?? "").trim().toLowerCase();
  return (URGENCIES as string[]).includes(v) ? (v as Urgency) : "unknown";
}

export function mapCertainty(raw: string | null | undefined): Certainty {
  const v = (raw ?? "").trim().toLowerCase();
  return (CERTAINTIES as string[]).includes(v) ? (v as Certainty) : "unknown";
}

/** Only two CAP outcomes are modelled: flooding, and everything else weather. */
export function mapEventType(capEvent: string | null | undefined): EventType {
  return (capEvent ?? "").toLowerCase().includes("flood") ? "flood" : "weather_warning";
}

/**
 * Zone-geometry resolution for zone-only alerts.
 *
 * Most CAP alerts (heat, wind, advisories) ship `geometry: null` plus
 * `affectedZones` — a list of api.weather.gov zone URLs whose responses carry
 * the official zone polygons. Joining an alert to NWS's own zone geometry is
 * not fabrication; it is the authoritative shape of the area the alert names.
 * Zones are effectively static, so successful lookups are cached for the
 * process lifetime; lookups are budgeted per poll so a cold start warms the
 * cache over a few 60s cycles instead of bursting dozens of requests.
 */
const MAX_ZONES_PER_ALERT = 6;
const MAX_ZONE_FETCHES_PER_POLL = 20;
/** url → zone polygon, or null when the zone has no usable geometry. */
const zoneGeometryCache = new Map<string, Polygon | MultiPolygon | null>();

const NwsZoneSchema = z.looseObject({ geometry: z.unknown().nullish() });

async function resolveZoneGeometry(
  url: string,
): Promise<Polygon | MultiPolygon | null | undefined> {
  if (zoneGeometryCache.has(url)) return zoneGeometryCache.get(url);
  let payload: unknown;
  try {
    payload = await fetchJson(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
      timeoutMs: 10_000,
    });
  } catch {
    // Transient failure: leave the cache untouched so the next poll retries.
    return undefined;
  }
  const zone = NwsZoneSchema.safeParse(payload);
  const geometry = zone.success ? GeometrySchema.safeParse(zone.data.geometry) : null;
  const usable =
    geometry?.success &&
    (geometry.data.type === "Polygon" || geometry.data.type === "MultiPolygon")
      ? geometry.data
      : null;
  zoneGeometryCache.set(url, usable);
  return usable;
}

/** Merge zone polygons into one MultiPolygon covering the whole alert area. */
function combineZonePolygons(zones: (Polygon | MultiPolygon)[]): MultiPolygon | null {
  const polygons = zones.flatMap((z) =>
    z.type === "Polygon" ? [z.coordinates] : z.coordinates,
  );
  return polygons.length > 0 ? { type: "MultiPolygon", coordinates: polygons } : null;
}

export const nwsConnector: Connector = {
  id: "nws",
  label: `National Weather Service active alerts (${REGION.nwsArea})`,
  source_tier: "A",
  expected_refresh_seconds: 60,

  async fetch(now: Date): Promise<ConnectorResult> {
    const retrieved_at = now.toISOString();
    try {
      const payload = await fetchJson(NWS_ALERTS_URL, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/geo+json",
        },
        timeoutMs: 10_000,
      });

      const parsed = NwsFeatureCollectionSchema.safeParse(payload);
      if (!parsed.success) {
        return {
          ok: false,
          retrieved_at,
          error: `unexpected NWS payload shape: ${parsed.error.message}`,
        };
      }

      const events: CanonicalEvent[] = [];
      const source_records: SourceRecord[] = [];
      let zoneFetchBudget = MAX_ZONE_FETCHES_PER_POLL;

      for (const feature of parsed.data.features) {
        const props = feature.properties;

        // NWS emits null geometry for zone-only alerts (the norm for heat and
        // advisory products). Resolve the official zone polygons from
        // `affectedZones` instead of skipping; an alert whose zones cannot be
        // resolved (yet) is skipped this poll and retried on the next.
        const inlineGeometry = GeometrySchema.safeParse(feature.geometry);
        let geometry = inlineGeometry.success ? inlineGeometry.data : null;
        let zoneDerived = false;
        if (!geometry) {
          const zoneUrls = (props.affectedZones ?? []).slice(0, MAX_ZONES_PER_ALERT);
          const zones: (Polygon | MultiPolygon)[] = [];
          for (const url of zoneUrls) {
            if (!zoneGeometryCache.has(url) && zoneFetchBudget <= 0) continue;
            if (!zoneGeometryCache.has(url)) zoneFetchBudget -= 1;
            const zone = await resolveZoneGeometry(url);
            if (zone) zones.push(zone);
          }
          geometry = combineZonePolygons(zones);
          zoneDerived = geometry !== null;
        }
        if (!geometry) continue;

        const providerRecordId = props.id ?? feature.id ?? null;
        const eventId = `nws:${providerRecordId ?? stableHashFallback(feature)}`;

        // Honest freshness: the alert's own issue time, never our fetch time.
        // Falling back to retrieved_at would make an undatable alert look
        // permanently fresh, so an alert we cannot date is dropped — the same
        // policy the FEMA connector applies to undatable shelters.
        const sent = toIso(props.sent) ?? toIso(props.effective);
        if (!sent) continue;

        const eventType = mapEventType(props.event);

        events.push(
          makeEvent(
            {
              event_id: eventId,
              event_type: eventType,
              headline:
                props.headline?.trim() ||
                props.event?.trim() ||
                "National Weather Service alert",
              description:
                props.description?.trim() ||
                props.areaDesc?.trim() ||
                "No description provided by the issuing office.",
              instructions: props.instruction?.trim() || null,
              severity: mapSeverity(props.severity),
              urgency: mapUrgency(props.urgency),
              certainty: mapCertainty(props.certainty),
              status: "active",
              geometry,
              starts_at: toIso(props.onset) ?? toIso(props.effective) ?? sent,
              ends_at: toIso(props.ends) ?? toIso(props.expires),
              last_verified_at: sent,
              best_tier: "A",
              source_count: 1,
              // Zone-derived shapes cover the whole named zone, coarser than
              // an alert-specific polygon drawn by the issuing office.
              geographic_precision: zoneDerived
                ? 0.6
                : geometry.type === "Point"
                  ? 0.8
                  : 1,
            },
            now,
          ),
        );

        source_records.push(
          makeSourceRecord({
            source_record_id: `nws-record:${providerRecordId ?? eventId}`,
            event_id: eventId,
            provider: "NWS",
            provider_record_id: providerRecordId,
            provider_tier: "A",
            source_url: feature.id ?? null,
            published_at: sent,
            retrieved_at,
            hash_input: stableStringify(feature),
          }),
        );
      }

      return { ok: true, retrieved_at, events, resources: [], source_records };
    } catch (err) {
      return { ok: false, retrieved_at, error: errorMessage(err) };
    }
  },
};

/** Last-resort identity for a feature with no upstream id. */
function stableHashFallback(feature: unknown): string {
  return hashContent(stableStringify(feature));
}
