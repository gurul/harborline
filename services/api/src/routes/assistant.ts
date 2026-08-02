/**
 * Assistant endpoint.
 *
 * The pipeline is: plan → run structured tools → compose → validate.
 *
 * Language never originates a fact here. The evidence bundle is built entirely
 * from store records by the tool layer; composition (deterministic, or Claude
 * when a key is configured) may only restate it; and `validateResponse` is the
 * last gate. An LLM answer that fails the validator is discarded in favour of
 * the deterministic composer, which is constructed to always pass.
 */
import { Hono } from "hono";
import {
  AssistantAskSchema,
  type AssistantResponse,
  type EventType,
  type LonLat,
  type SourceRecord,
} from "@harborline/event-schema";
import {
  composeResponse,
  llmCompose,
  planQuery,
  tools,
  validateResponse,
  type EvidenceBundle,
  type QueryIntent,
  type RejectedResource,
  type ToolContext,
} from "@harborline/agent-tools";
import { store } from "../state.js";

/** Search radius for assistant evidence gathering, in meters. */
export const ASSISTANT_RADIUS_M = 8000;
/** "What changed" window, in milliseconds. */
export const RECENT_WINDOW_MS = 60 * 60 * 1000;
const LLM_TIMEOUT_MS = 15_000;

const HAZARD_TYPES: EventType[] = ["road_closure", "flood", "evacuation_order"];

function attachRecords(ctx: ToolContext, bundle: EvidenceBundle): EvidenceBundle {
  const records: SourceRecord[] = [];
  for (const event of bundle.events) {
    const detail = ctx.store.getEvent(event.event_id);
    if (detail) records.push(...detail.source_records);
  }
  bundle.source_records = records;
  return bundle;
}

/**
 * Run the tools the plan selects. Each branch is an explicit, inspectable tool
 * combination — the model never chooses what evidence it gets.
 */
export function buildEvidence(
  ctx: ToolContext,
  intent: QueryIntent,
  at: LonLat,
): EvidenceBundle {
  const [lon, lat] = at;

  const activeEvents = (types?: EventType[]) =>
    tools.get_active_events(ctx, { lat, lon, radius_m: ASSISTANT_RADIUS_M, types }).events;

  const bundle: EvidenceBundle = { events: [] };

  switch (intent) {
    case "nearest_shelter": {
      const nearby = tools.get_nearby_resources(ctx, { lat, lon, resource_type: "shelter" });
      bundle.resources = nearby.recommendable;
      bundle.rejected_resources = nearby.rejected as RejectedResource[];
      bundle.events = activeEvents();

      const destination = nearby.recommendable[0];
      if (destination) {
        const route = tools.calculate_routes(ctx, {
          from_lat: lat,
          from_lon: lon,
          to_resource_id: destination.resource_id,
        });
        bundle.route = {
          candidates: route.candidates,
          recommendation: route.recommendation,
          destination: route.destination,
        };
      }
      break;
    }

    case "roads_to_avoid": {
      bundle.events = activeEvents(HAZARD_TYPES);
      break;
    }

    case "what_changed": {
      const cutoff = ctx.now.getTime() - RECENT_WINDOW_MS;
      const recent = activeEvents().filter(
        (e) => new Date(e.last_verified_at).getTime() >= cutoff,
      );
      // Nothing verified in the window is itself an answer — do not widen it.
      bundle.events = recent;
      break;
    }

    case "resource_query": {
      const nearby = tools.get_nearby_resources(ctx, { lat, lon });
      bundle.resources = nearby.recommendable;
      bundle.rejected_resources = nearby.rejected as RejectedResource[];
      bundle.events = activeEvents();
      break;
    }

    case "area_status":
    case "general":
    default: {
      bundle.events = activeEvents();
      break;
    }
  }

  return attachRecords(ctx, bundle);
}

export const assistantRoutes = new Hono();

assistantRoutes.post("/ask", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body", message: "Body must be JSON." }, 400);
  }

  const parsed = AssistantAskSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }

  const now = new Date();
  const ctx: ToolContext = { store, now };
  const at: LonLat = [parsed.data.lon, parsed.data.lat];
  const { intent } = planQuery(parsed.data.question);
  const evidence = buildEvidence(ctx, intent, at);

  let response: AssistantResponse | null = null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      response = await llmCompose(parsed.data.question, evidence, {
        apiKey,
        model: process.env.ANTHROPIC_MODEL,
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(
        `[assistant] llmCompose failed, falling back to deterministic composer: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      response = null;
    }
  }

  if (response) {
    const check = validateResponse(response, evidence, now);
    if (!check.ok) {
      console.warn(`[assistant] LLM answer rejected: ${check.violations.join("; ")}`);
      response = null;
    }
  }

  if (!response) {
    response = composeResponse(parsed.data.question, evidence, now);
    const check = validateResponse(response, evidence, now);
    if (!check.ok) {
      // The deterministic composer is built to pass. Reaching here is a bug in
      // the composer or the validator — surface it rather than answering.
      console.error(
        `[assistant] BUG: deterministic answer failed validation: ${check.violations.join("; ")}`,
      );
      return c.json(
        {
          error: "unsafe_response",
          message: "Could not produce an answer that satisfies the safety policy.",
          violations: check.violations,
        },
        500,
      );
    }
  }

  return c.json(response);
});
