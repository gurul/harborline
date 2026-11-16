import { z } from "zod";
import { MultiPolygonSchema, PointSchema, PolygonSchema } from "./geo.js";
import { ParseableTimestampSchema, SourceTierSchema } from "./events.js";

/**
 * Observations: measured conditions at a place (an air-quality reading, a river
 * gauge, a satellite smoke analysis). They are neither events nor resources.
 *
 * An observation never enters the hazard path. A gauge's location is not a
 * flood area and an AQI value does not block a road, so observations never
 * eliminate a route or reject a shelter. They age by freshness only and are
 * not reconciled by absence.
 */
export const ObservationKindSchema = z.enum(["air_quality", "stream_gauge", "smoke"]);
export type ObservationKind = z.infer<typeof ObservationKindSchema>;

/** EPA AQI categories, as AirNow names them, plus "Unknown". */
export const AqiCategorySchema = z.enum([
  "Good",
  "Moderate",
  "Unhealthy for Sensitive Groups",
  "Unhealthy",
  "Very Unhealthy",
  "Hazardous",
  "Unknown",
]);
export type AqiCategory = z.infer<typeof AqiCategorySchema>;

/** NWS flood categories for a gauge. Anything the service cannot rate is unknown. */
export const FloodCategorySchema = z.enum([
  "no_flooding",
  "action",
  "minor",
  "moderate",
  "major",
  "unknown",
]);
export type FloodCategory = z.infer<typeof FloodCategorySchema>;

export const SmokeDensitySchema = z.enum(["light", "medium", "heavy", "unknown"]);
export type SmokeDensity = z.infer<typeof SmokeDensitySchema>;

const ObservationBase = z.object({
  observation_id: z.string().min(1).max(200).regex(/^[^\r\n]+$/),
  name: z.string(),
  /** Where the reading applies. For smoke, the centre of the analysed area. */
  location: PointSchema,
  /** Time the condition was measured or analysed. */
  observed_at: ParseableTimestampSchema,
  /** Freshness clock. Equal to `observed_at` for every current connector. */
  last_verified_at: ParseableTimestampSchema,
  provider: z.string(),
  provider_tier: SourceTierSchema,
  source_url: z.string().nullable(),
});

export const AirQualityObservationSchema = ObservationBase.extend({
  kind: z.literal("air_quality"),
  aqi: z.number().int().min(0).max(1000),
  category: AqiCategorySchema,
  /** Pollutant that sets the AQI, e.g. "PM2.5" or "OZONE". */
  pollutant: z.string(),
});

export const StreamGaugeObservationSchema = ObservationBase.extend({
  kind: z.literal("stream_gauge"),
  site_id: z.string(),
  stage_ft: z.number().nullable(),
  flow_cfs: z.number().nullable(),
  flood_category: FloodCategorySchema,
  /** Forecast category when the service publishes a current forecast. */
  forecast_category: FloodCategorySchema.nullable(),
});

export const SmokeObservationSchema = ObservationBase.extend({
  kind: z.literal("smoke"),
  area: z.union([PolygonSchema, MultiPolygonSchema]),
  density: SmokeDensitySchema,
  /** Start of the analysed period; `observed_at` is its end. */
  starts_at: ParseableTimestampSchema,
});

export const ObservationSchema = z.discriminatedUnion("kind", [
  AirQualityObservationSchema,
  StreamGaugeObservationSchema,
  SmokeObservationSchema,
]);
export type Observation = z.infer<typeof ObservationSchema>;
export type AirQualityObservation = z.infer<typeof AirQualityObservationSchema>;
export type StreamGaugeObservation = z.infer<typeof StreamGaugeObservationSchema>;
export type SmokeObservation = z.infer<typeof SmokeObservationSchema>;

/** An observation with its distance from a query point. */
export type NearbyObservation = Observation & { distance_m: number };

/** AQI value to EPA category. */
export function aqiCategory(aqi: number): AqiCategory {
  if (!Number.isFinite(aqi) || aqi < 0) return "Unknown";
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}
