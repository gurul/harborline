import { z } from "zod";
import { LineStringSchema } from "./geo.js";

export const RoadSegmentStatusSchema = z.enum(["open", "closed", "hazardous", "unknown"]);
export type RoadSegmentStatus = z.infer<typeof RoadSegmentStatusSchema>;

export const RoadSegmentSchema = z.object({
  segment_id: z.string(),
  name: z.string().nullable(),
  geometry: LineStringSchema,
  status: RoadSegmentStatusSchema,
  hazard_event_ids: z.array(z.string()),
});
export type RoadSegment = z.infer<typeof RoadSegmentSchema>;

export const RouteCandidateSchema = z.object({
  route_id: z.string(),
  geometry: LineStringSchema,
  distance_m: z.number(),
  duration_min: z.number(),
  hazard_exposure_m: z.number(),
  intersecting_event_ids: z.array(z.string()),
  risk_score: z.number(),
  eliminated: z.boolean(),
  rejected_reason: z
    .enum(["closure_intersection", "evacuation_zone", "no_path"])
    .nullable(),
});
export type RouteCandidate = z.infer<typeof RouteCandidateSchema>;

export const RouteRecommendationSchema = z.object({
  recommendation_id: z.string(),
  route_id: z.string(),
  destination_resource_id: z.string(),
  summary: z.string(), // MUST use "lowest-risk … currently available" language, never "safe"
  duration_min: z.number(),
  avoided_hazard_count: z.number().int(),
  evidence_event_ids: z.array(z.string()),
  generated_at: z.string(),
  expires_at: z.string(),
  routing: z.literal("demonstration"),
});
export type RouteRecommendation = z.infer<typeof RouteRecommendationSchema>;
