import { z } from "zod";
import {
  PUGET_SOUND_BBOX,
  bboxContains,
  type CanonicalEvent,
  type Connector,
  type ConnectorResult,
  type LonLat,
  type Severity,
  type SourceRecord,
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

export const USGS_FEED_URL =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson";

const UsgsPropertiesSchema = z.looseObject({
  mag: z.number().nullish(),
  place: z.string().nullish(),
  time: z.number().nullish(),
  updated: z.number().nullish(),
  url: z.string().nullish(),
  title: z.string().nullish(),
  status: z.string().nullish(),
  tsunami: z.number().nullish(),
});

const UsgsFeatureSchema = z.looseObject({
  id: z.string().optional(),
  properties: UsgsPropertiesSchema,
  geometry: z
    .looseObject({
      type: z.string(),
      // [lon, lat, depth_km] — depth is present, so this cannot be a 2-tuple.
      coordinates: z.array(z.number()).min(2),
    })
    .nullish(),
});

const UsgsFeedSchema = z.looseObject({
  features: z.array(UsgsFeatureSchema).default([]),
});

/** Richter magnitude → canonical severity. */
export function magnitudeToSeverity(mag: number): Severity {
  if (mag < 3.5) return "minor";
  if (mag < 4.5) return "moderate";
  if (mag < 6.0) return "severe";
  return "extreme";
}

export const usgsConnector: Connector = {
  id: "usgs",
  label: "USGS earthquakes M2.5+ (past week)",
  source_tier: "A",
  expected_refresh_seconds: 300,

  async fetch(now: Date): Promise<ConnectorResult> {
    const retrieved_at = now.toISOString();
    try {
      const payload = await fetchJson(USGS_FEED_URL, {
        headers: { Accept: "application/geo+json" },
        timeoutMs: 10_000,
      });

      const parsed = UsgsFeedSchema.safeParse(payload);
      if (!parsed.success) {
        return {
          ok: false,
          retrieved_at,
          error: `unexpected USGS payload shape: ${parsed.error.message}`,
        };
      }

      const events: CanonicalEvent[] = [];
      const source_records: SourceRecord[] = [];

      for (const feature of parsed.data.features) {
        const coords = feature.geometry?.coordinates;
        if (!coords || coords.length < 2) continue;
        const epicenter: LonLat = [coords[0]!, coords[1]!];
        if (!bboxContains(PUGET_SOUND_BBOX, epicenter)) continue;

        const props = feature.properties;
        const mag = typeof props.mag === "number" ? props.mag : null;
        if (mag === null) continue;

        const providerRecordId = feature.id ?? null;
        const eventId = `usgs:${providerRecordId ?? hashContent(stableStringify(feature))}`;
        const occurredAt = toIso(props.time) ?? retrieved_at;
        // Honest freshness: the review timestamp, not our fetch time.
        const lastVerifiedAt = toIso(props.updated) ?? occurredAt;
        const place = props.place?.trim() || "Puget Sound region";

        events.push(
          makeEvent(
            {
              event_id: eventId,
              event_type: "earthquake",
              headline: `M${mag.toFixed(1)} earthquake — ${place}`,
              description:
                props.title?.trim() ||
                `A magnitude ${mag.toFixed(1)} earthquake was recorded ${place}.`,
              instructions: null,
              severity: magnitudeToSeverity(mag),
              urgency: "past",
              certainty: "observed",
              status: "active",
              geometry: { type: "Point", coordinates: epicenter },
              starts_at: occurredAt,
              ends_at: null,
              last_verified_at: lastVerifiedAt,
              best_tier: "A",
              source_count: 1,
            },
            now,
          ),
        );

        source_records.push(
          makeSourceRecord({
            source_record_id: `usgs-record:${providerRecordId ?? eventId}`,
            event_id: eventId,
            provider: "USGS",
            provider_record_id: providerRecordId,
            provider_tier: "A",
            source_url: props.url ?? null,
            published_at: occurredAt,
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
