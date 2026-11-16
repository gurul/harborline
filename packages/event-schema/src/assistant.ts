import { z } from "zod";
import { SourceTierSchema } from "./events.js";
import { RouteCandidateSchema, RouteRecommendationSchema } from "./routing.js";

/**
 * Access needs a caller can state. The set is exactly the needs a shelter
 * record can decide today: `wheelchair` and `accessible_restroom` from
 * `accessibility_features`, and `pets` from `pet_policy`. They change shelter
 * ranking deterministically; they never reach a model prompt.
 */
export const AccessNeedSchema = z.enum(["wheelchair", "accessible_restroom", "pets"]);
export type AccessNeed = z.infer<typeof AccessNeedSchema>;

export const AssistantSourceSchema = z.object({
  provider: z.string(),
  tier: SourceTierSchema,
  url: z.string().nullable(),
  last_verified_at: z.string(),
});
export type AssistantSource = z.infer<typeof AssistantSourceSchema>;

export const AssistantResponseSchema = z.object({
  answer_markdown: z.string(),
  recommended_action: z.string().nullable(),
  sources: z.array(AssistantSourceSchema),
  freshness_note: z.string(),
  uncertainty_note: z.string().nullable(),
  evidence_event_ids: z.array(z.string()),
  composed_by: z.enum(["deterministic", "llm"]),
  /**
   * The shelter the answer recommends, or null. The route below always ends
   * at this resource, so a client can draw the route without a second call
   * (or call GET /v1/routes?to_resource_id=<this id> for the full set).
   */
  destination_resource_id: z.string().nullable().optional(),
  /** The recommended route to `destination_resource_id`, when one survived. */
  route: z
    .object({ recommendation: RouteRecommendationSchema, candidate: RouteCandidateSchema })
    .nullable()
    .optional(),
  /** Access needs applied to the shelter ranking, echoed back. */
  access_needs_applied: z.array(AccessNeedSchema).optional(),
});
export type AssistantResponse = z.infer<typeof AssistantResponseSchema>;

export const AssistantAskSchema = z.object({
  question: z.string().min(1).max(500),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Optional access needs; applied by ranking, never by model text. */
  access_needs: z.array(AccessNeedSchema).max(3).optional(),
  /**
   * Optional shelter to route to. When it is recommendable it becomes the
   * answer's destination; when it is not, the answer says why and names the
   * best other option.
   */
  destination_resource_id: z.string().min(1).max(200).regex(/^[^\r\n]+$/).optional(),
});
export type AssistantAsk = z.infer<typeof AssistantAskSchema>;
