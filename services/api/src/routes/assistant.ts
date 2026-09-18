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
  type LonLat,
} from "@harborline/event-schema";
import {
  composeResponse,
  gatherEvidence,
  immediateHazardNote,
  llmCompose,
  llmComposeOpenAi,
  validateResponse,
  type ToolContext,
} from "@harborline/agent-tools";
import { store } from "../state.js";

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
  const evidence = gatherEvidence(ctx, parsed.data.question, at);

  let response: AssistantResponse | null = null;
  // Anthropic and OpenAI are interchangeable wording layers behind the same
  // prompt, validator and deterministic fallback. Anthropic keeps precedence
  // for existing deploys; OPENAI_API_KEY alone routes through the Responses API.
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openAiKey = process.env.OPENAI_API_KEY;
  const apiKey = anthropicKey ?? openAiKey;
  if (apiKey && activeLlmCalls < MAX_CONCURRENT_LLM) {
    activeLlmCalls += 1;
    try {
      // Only the prompt sees the capped bundle. Sources, freshness and evidence
      // IDs below are still derived from the full one, so capping can never
      // drop provenance from what the user is shown.
      const compose = anthropicKey ? llmCompose : llmComposeOpenAi;
      response = await compose(parsed.data.question, evidence, {
        apiKey,
        model: anthropicKey
          ? process.env.ANTHROPIC_MODEL
          : process.env.OPENAI_MODEL,
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
    // Benchmark criterion 6 (Camp Fire): the act-now note for an
    // `immediate`-urgency severe hazard is a system guarantee, not a model
    // choice — the deterministic composer emits it itself; LLM answers get it
    // appended here so both paths carry it.
    const urgent = immediateHazardNote(evidence);
    if (urgent && !response.answer_markdown.includes("zone-by-zone")) {
      response = {
        ...response,
        answer_markdown: `${response.answer_markdown}\n\n${urgent}`,
      };
    }
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
