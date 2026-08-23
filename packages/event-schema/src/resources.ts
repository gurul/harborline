import { z } from "zod";
import { PointSchema } from "./geo.js";
import { ParseableTimestampSchema, SourceTierSchema } from "./events.js";

export const ResourceTypeSchema = z.enum([
  "shelter",
  "hospital",
  "cooling_center",
  "food_water",
  "charging",
  "transport_hub",
]);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

export const OperationalStatusSchema = z.enum(["open", "closed", "full", "unknown"]);
export type OperationalStatus = z.infer<typeof OperationalStatusSchema>;

export const ResourceSchema = z.object({
  resource_id: z.string(),
  resource_type: ResourceTypeSchema,
  name: z.string(),
  location: PointSchema,
  address: z.string().nullable(),
  operational_status: OperationalStatusSchema,
  capacity_total: z.number().int().nullable(),
  capacity_available: z.number().int().nullable(),
  accessibility_features: z.array(z.string()),
  /**
   * Public-health caveat for an otherwise-open facility (e.g. a disease
   * outbreak). Camp Fire precedent: norovirus at four official shelters,
   * 140+ symptomatic, while every one of them stayed "open". Surfaced with
   * the recommendation, never hidden behind operational_status.
   */
  health_advisory: z.string().nullable().default(null),
  pet_policy: z.string().nullable(),
  contact_information: z.string().nullable(),
  last_verified_at: ParseableTimestampSchema,
  provider: z.string(),
  provider_tier: SourceTierSchema,
  source_url: z.string().nullable(),
});
export type Resource = z.infer<typeof ResourceSchema>;

/** A resource enriched with distance from a query point. */
export const NearbyResourceSchema = ResourceSchema.extend({
  distance_m: z.number(),
});
export type NearbyResource = z.infer<typeof NearbyResourceSchema>;
