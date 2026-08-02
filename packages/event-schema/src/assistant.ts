import { z } from "zod";
import { SourceTierSchema } from "./events.js";

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
});
export type AssistantResponse = z.infer<typeof AssistantResponseSchema>;

export const AssistantAskSchema = z.object({
  question: z.string().min(1).max(500),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type AssistantAsk = z.infer<typeof AssistantAskSchema>;
