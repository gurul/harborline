import { z } from "zod";
import {
  GeometrySchema,
  type CanonicalEvent,
  type Certainty,
  type Connector,
  type ConnectorResult,
  type EventType,
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

export const NWS_ALERTS_URL = "https://api.weather.gov/alerts/active?area=WA";

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

export const nwsConnector: Connector = {
  id: "nws",
  label: "National Weather Service active alerts (WA)",
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

      for (const feature of parsed.data.features) {
        const props = feature.properties;

        // Affected-zone fallback: NWS emits null geometry for zone-only alerts.
        // We do not have the zone shapefiles locally, and fabricating a
        // geometry would violate the no-inference rule — so we skip them.
        const geometry = GeometrySchema.safeParse(feature.geometry);
        if (!geometry.success) continue;

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
              geometry: geometry.data,
              starts_at: toIso(props.onset) ?? toIso(props.effective) ?? sent,
              ends_at: toIso(props.ends) ?? toIso(props.expires),
              last_verified_at: sent,
              best_tier: "A",
              source_count: 1,
              geographic_precision: geometry.data.type === "Point" ? 0.8 : 1,
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
