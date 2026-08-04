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
  capEvidenceForPrompt,
  composeResponse,
  HAZARD_EVENT_TYPES,
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

/**
 * Ceiling on in-flight model calls. Each one holds a socket and a token budget
 * for up to `LLM_TIMEOUT_MS`; without a cap, a burst that slips past the rate
 * limiter (multiple client IPs) turns into unbounded upstream concurrency.
 * Saturation degrades to the deterministic composer rather than queueing —
 * waiting in line behind four 15s calls is worse than an instant grounded
 * answer, and the deterministic path is the safety floor anyway.
 */
export const MAX_CONCURRENT_LLM = 4;
let activeLlmCalls = 0;

/** Appended when the answer served did not clear the validator. */
export const SAFETY_FLAG_NOTE =
  "Automated safety checks flagged this answer; verify with official sources.";

function appendUncertainty(response: AssistantResponse, note: string): AssistantResponse {
  const existing = response.uncertainty_note?.trim();
  return {
    ...response,
    uncertainty_note: existing && existing.length > 0 ? `${existing} ${note}` : note,
  };
}

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
      bundle.events = activeEvents(HAZARD_EVENT_TYPES);
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
    return c.json(
      {
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.map((p) => String(p)).join("."),
          code: i.code,
        })),
      },
      400,
    );
  }

  const now = new Date();
  const ctx: ToolContext = { store, now };
  const at: LonLat = [parsed.data.lon, parsed.data.lat];
  const { intent } = planQuery(parsed.data.question);
  const evidence = buildEvidence(ctx, intent, at);

  let response: AssistantResponse | null = null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && activeLlmCalls < MAX_CONCURRENT_LLM) {
    activeLlmCalls += 1;
    try {
      // Only the prompt sees the capped bundle. Sources, freshness and evidence
      // IDs below are still derived from the full one, so capping can never
      // drop provenance from what the user is shown.
      response = await llmCompose(parsed.data.question, capEvidenceForPrompt(evidence), {
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
    } finally {
      activeLlmCalls -= 1;
    }
  } else if (apiKey) {
    console.warn(
      `[assistant] llmCompose saturated (${activeLlmCalls}/${MAX_CONCURRENT_LLM} in flight), using deterministic composer`,
    );
  }

  if (response) {
    // Validate against a fresh clock, not the pre-call one: the LLM call can
    // take up to LLM_TIMEOUT_MS, and a record that crossed its freshness
    // boundary mid-call must be caught here, not validated as still current.
    const check = validateResponse(response, evidence, new Date());
    if (!check.ok) {
      console.warn(`[assistant] LLM answer rejected: ${check.violations.join("; ")}`);
      response = null;
    }
  }

  if (!response) {
    let deterministic: AssistantResponse;
    try {
      // Fresh clock for the same reason as validation above: this branch may
      // run after a full LLM timeout.
      deterministic = composeResponse(parsed.data.question, evidence, new Date());
    } catch (err) {
      // A throwing composer means there is no answer to serve at all.
      console.error("[assistant] deterministic composer threw:", err);
      return c.json(
        {
          error: "unsafe_response",
          message: "Could not produce an answer that satisfies the safety policy.",
        },
        500,
      );
    }

    const check = validateResponse(deterministic, evidence, new Date());
    if (!check.ok) {
      // The deterministic composer is built to pass, so this is a bug in the
      // composer or the validator — but withholding the answer is the worse
      // failure during an emergency. Serve the grounded response (it is built
      // only from store records) and flag it, loudly, in the log.
      console.error(
        `[assistant] BUG: deterministic answer failed validation: ${check.violations.join("; ")}`,
      );
      deterministic = appendUncertainty(deterministic, SAFETY_FLAG_NOTE);
    }
    response = deterministic;
  }

  return c.json(response);
});
