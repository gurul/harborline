import { z } from "zod";
import { GeometrySchema } from "./geo.js";

export const EventTypeSchema = z.enum([
  "flood",
  "road_closure",
  "power_outage",
  "earthquake",
  "fire",
  "landslide",
  "shelter_open",
  "shelter_full",
  "transit_disruption",
  "evacuation_order",
  "weather_warning",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const SeveritySchema = z.enum(["minor", "moderate", "severe", "extreme"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const UrgencySchema = z.enum(["immediate", "expected", "future", "past", "unknown"]);
export type Urgency = z.infer<typeof UrgencySchema>;

export const CertaintySchema = z.enum(["observed", "likely", "possible", "unlikely", "unknown"]);
export type Certainty = z.infer<typeof CertaintySchema>;

export const EventStatusSchema = z.enum(["active", "expired", "cancelled"]);
export type EventStatus = z.infer<typeof EventStatusSchema>;

/**
 * Source authority tiers.
 * A — issuing authority (NWS warning, city evacuation order)
 * B — operational authority (utility outage feed, DOT closure)
 * C — verified institution (established local newsroom)
 * D — corroborated community report
 * E — unverified report
 */
export const SourceTierSchema = z.enum(["A", "B", "C", "D", "E"]);
export type SourceTier = z.infer<typeof SourceTierSchema>;

export const ConfidenceLabelSchema = z.enum([
  "official",
  "verified",
  "developing",
  "unverified",
]);
export type ConfidenceLabel = z.infer<typeof ConfidenceLabelSchema>;

export const SourceRecordSchema = z.object({
  source_record_id: z.string(),
  event_id: z.string().nullable(),
  provider: z.string(), // e.g. "NWS", a DOT / public-works feed, a local newsroom
  provider_record_id: z.string().nullable(),
  provider_tier: SourceTierSchema,
  source_url: z.string().nullable(),
  published_at: z.string(), // ISO 8601
  retrieved_at: z.string(),
  content_hash: z.string(),
  raw_payload: z.unknown().optional(),
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

/**
 * Event identifier. Bounded in length and free of line breaks so an id can be
 * safely interpolated into a log line, a URL path, or an LLM prompt without
 * carrying an injected newline with it.
 */
export const EventIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\r\n]+$/);

export const CanonicalEventSchema = z.object({
  event_id: EventIdSchema,
  event_type: EventTypeSchema,
  headline: z.string(),
  description: z.string(),
  instructions: z.string().nullable(),
  severity: SeveritySchema,
  urgency: UrgencySchema,
  certainty: CertaintySchema,
  status: EventStatusSchema,
  geometry: GeometrySchema,
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  last_verified_at: z.string(),
  source_count: z.number().int().min(1),
  /** Highest-authority tier among contributing sources. */
  best_tier: SourceTierSchema,
  confidence_score: z.number().min(0).max(1),
  confidence_label: ConfidenceLabelSchema,
  /** Present when a lower-tier source disputes this event's status. */
  contradiction_note: z.string().nullable(),
});
export type CanonicalEvent = z.infer<typeof CanonicalEventSchema>;

export const SEVERITY_RANK: Record<Severity, number> = {
  minor: 1,
  moderate: 2,
  severe: 3,
  extreme: 4,
};
