/**
 * Optional LLM composition.
 *
 * The model is allowed to rephrase — nothing more. Sources, freshness, the
 * uncertainty note and the evidence IDs are all computed deterministically from
 * the bundle and are NOT taken from the model; only `answer_markdown` and
 * `recommended_action` come back from Claude, and both still pass through
 * `validateResponse` before anything is shown.
 *
 * Raw `fetch` against the Messages API — this package has no SDK dependency.
 */
import type { AssistantResponse } from "@harborline/event-schema";
import {
  buildFreshnessNote,
  buildSources,
  buildUncertaintyNote,
  type EvidenceBundle,
} from "./composer.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1000;

export interface LlmComposeOptions {
  apiKey: string;
  model?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export const LLM_SYSTEM_PROMPT = [
  "You are the language surface of Harborline, a disaster-information system.",
  "",
  "The JSON evidence you are given is the ONLY source of truth. You restate it; you never originate it.",
  "",
  "Hard rules:",
  "1. Use ONLY facts present in the evidence JSON. If something is not in the evidence, it does not exist. Never infer, extrapolate, or fill gaps from general knowledge.",
  "2. Every operational claim (a shelter's status, a road's status, capacity) must carry the age of the record it comes from and the name of the source, e.g. \"verified 8 minutes ago, Seattle Emergency Management\".",
  "3. Never describe a record as current if the evidence marks it stale. Say when it was last confirmed instead, and say it is excluded from recommendations.",
  "4. Forbidden words and phrases: \"safe\", \"guaranteed\", \"no danger\", \"completely safe\", \"100% safe\". Routes are described as \"the lowest-risk route currently available\" and conditions may change.",
  "5. If the evidence contains an active evacuation order, never advise staying home or staying put.",
  "6. If the evidence is empty, say plainly that no verified reports are available. Do not guess.",
  "",
  "Return ONLY a JSON object, with no prose or code fences around it:",
  '{"answer_markdown": "<markdown answer>", "recommended_action": "<one short sentence, or null>"}',
].join("\n");

interface AnthropicTextBlock {
  type: string;
  text?: string;
}

interface AnthropicMessageResponse {
  content?: AnthropicTextBlock[];
}

function extractJsonObject(text: string): { answer_markdown: string; recommended_action: string | null } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("llmCompose: model response contained no JSON object");
  }
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("llmCompose: model response JSON was not an object");
  }
  const record = parsed as Record<string, unknown>;
  const answer = record["answer_markdown"];
  if (typeof answer !== "string" || answer.trim() === "") {
    throw new Error("llmCompose: model response is missing answer_markdown");
  }
  const action = record["recommended_action"];
  return {
    answer_markdown: answer,
    recommended_action: typeof action === "string" && action.trim() !== "" ? action : null,
  };
}

/**
 * Compose an answer with Claude. Throws on any failure — the caller is expected
 * to fall back to `composeResponse`, which is constructed to always pass the
 * validator.
 */
export async function llmCompose(
  question: string,
  evidence: EvidenceBundle,
  opts: LlmComposeOptions,
): Promise<AssistantResponse> {
  if (!opts.apiKey) throw new Error("llmCompose: apiKey is required");
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("llmCompose: no fetch implementation available");
  }

  const now = new Date();
  const userContent = [
    `Question: ${question}`,
    "",
    "Evidence JSON:",
    JSON.stringify(evidence),
  ].join("\n");

  const response = await doFetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      system: LLM_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
    signal: opts.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`llmCompose: Anthropic API ${response.status} ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as AnthropicMessageResponse;
  const text = (payload.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();

  if (text === "") throw new Error("llmCompose: Anthropic API returned no text content");

  const parsed = extractJsonObject(text);

  return {
    answer_markdown: parsed.answer_markdown,
    recommended_action: parsed.recommended_action,
    // Provenance is never delegated to the model.
    sources: buildSources(evidence),
    freshness_note: buildFreshnessNote(evidence, now),
    uncertainty_note: buildUncertaintyNote(evidence, now),
    evidence_event_ids: [
      ...new Set([
        ...evidence.events.map((e) => e.event_id),
        ...(evidence.route?.recommendation?.evidence_event_ids ?? []),
      ]),
    ],
    composed_by: "llm",
  };
}
