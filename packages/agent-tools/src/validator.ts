/**
 * Safety-policy validator.
 *
 * The last gate before a composed answer reaches a user. It checks the answer
 * text against the evidence bundle that produced it, so an LLM-composed answer
 * cannot smuggle in a claim the records do not support. The deterministic
 * composer is built to always pass; when the LLM path fails here, the API falls
 * back to the deterministic answer.
 */
import {
  type AssistantResponse,
  type CanonicalEvent,
  type NearbyResource,
  eventMaxAge,
  isStale,
  resourceMaxAge,
} from "@harborline/event-schema";
import type { EvidenceBundle } from "./composer.js";

export interface ValidationResult {
  ok: boolean;
  violations: string[];
}

/** Rule 3 — language that promises an outcome no data can support. */
export const GUARANTEE_PATTERNS: RegExp[] = [
  /route is safe/i,
  /completely safe/i,
  /totally safe/i,
  /100% safe/i,
  /guaranteed/i,
  /guarantee\b/i,
  /no danger/i,
  /it is safe to/i,
];

/** Rule 1 — words that assert something about the physical world. */
const OPERATIONAL_CLAIM = /\b(open|closed|blocked|full|capacity|operating)\b/gi;

/** Rule 2 — present-tense operational state, e.g. "the shelter is open". */
const PRESENT_CLAIM =
  /\b(is|are|remains?|stays?)\s+(currently\s+)?(open|closed|operating|full|accepting|blocked)\b/i;

/** Rule 4 — shelter-in-place advice. */
const STAY_PUT = /stay\s+(home|put|where you are)/i;

/** Rule 5 escape hatch — an explicit "we have nothing" answer. */
const NO_DATA_DISCLAIMER = /no verified (reports?|records?|data)/i;

const RESOURCE_CLAIM_WORDS = new Set(["open", "closed", "full", "capacity", "operating"]);
const ROAD_CLAIM_WORDS = new Set(["blocked", "closed"]);

const ROAD_EVENT_TYPES = new Set([
  "road_closure",
  "evacuation_order",
  "flood",
  "landslide",
  "fire",
]);
const SHELTER_EVENT_TYPES = new Set(["shelter_open", "shelter_full"]);

function allResources(evidence: EvidenceBundle): NearbyResource[] {
  return [
    ...(evidence.resources ?? []),
    ...(evidence.rejected_resources ?? []).map((r) => r.resource),
  ];
}

function staleEvents(evidence: EvidenceBundle, now: Date): CanonicalEvent[] {
  return evidence.events.filter((e) =>
    isStale(e.last_verified_at, eventMaxAge(e.event_type), now),
  );
}

function staleResources(evidence: EvidenceBundle, now: Date): NearbyResource[] {
  return allResources(evidence).filter((r) =>
    isStale(r.last_verified_at, resourceMaxAge(r.resource_type), now),
  );
}

/**
 * True when `name` appears in `text` and a present-tense operational claim
 * follows within a short window. Scoped so an unrelated claim elsewhere in the
 * answer does not get attributed to a record merely because it was mentioned.
 */
function claimsCurrencyAbout(text: string, name: string, windowChars = 80): boolean {
  if (!name) return false;
  const haystack = text.toLowerCase();
  const needle = name.toLowerCase();
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const window = text.slice(index, index + needle.length + windowChars);
    if (PRESENT_CLAIM.test(window)) return true;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return false;
}

export function validateResponse(
  response: AssistantResponse,
  evidence: EvidenceBundle,
  now: Date,
): ValidationResult {
  const violations: string[] = [];
  const answer = response.answer_markdown ?? "";
  const text = `${answer}\n${response.recommended_action ?? ""}`;

  const resources = allResources(evidence);
  const hasResourceEvidence =
    resources.length > 0 ||
    evidence.events.some((e) => SHELTER_EVENT_TYPES.has(e.event_type));
  const hasRoadEvidence =
    evidence.events.some((e) => ROAD_EVENT_TYPES.has(e.event_type)) || resources.length > 0;

  // --- Rule 1: operational claims need matching evidence + attribution ------
  const claimWords = new Set(
    [...text.matchAll(OPERATIONAL_CLAIM)].map((m) => m[0].toLowerCase()),
  );
  for (const word of claimWords) {
    const supported =
      (RESOURCE_CLAIM_WORDS.has(word) && hasResourceEvidence) ||
      (ROAD_CLAIM_WORDS.has(word) && hasRoadEvidence);
    if (!supported) {
      violations.push(
        `operational_claim_unsupported: answer claims "${word}" but the evidence bundle has no matching record`,
      );
    }
  }
  if (claimWords.size > 0 && response.sources.length === 0) {
    violations.push(
      "operational_claim_unattributed: answer makes an operational claim with no sources",
    );
  }

  // --- Rule 2: no describing a record past its freshness policy as current --
  if (PRESENT_CLAIM.test(text)) {
    const freshEvents = evidence.events.filter(
      (e) => !isStale(e.last_verified_at, eventMaxAge(e.event_type), now),
    );
    const freshResources = resources.filter(
      (r) => !isStale(r.last_verified_at, resourceMaxAge(r.resource_type), now),
    );
    if (freshEvents.length === 0 && freshResources.length === 0) {
      violations.push(
        "stale_claim_as_current: answer states a current operational status but every supporting record is past its freshness policy",
      );
    }
  }
  for (const resource of staleResources(evidence, now)) {
    if (claimsCurrencyAbout(text, resource.name)) {
      violations.push(
        `stale_claim_as_current: answer describes "${resource.name}" as currently operating, but its record is past the freshness policy`,
      );
    }
  }
  for (const event of staleEvents(evidence, now)) {
    if (claimsCurrencyAbout(text, event.headline)) {
      violations.push(
        `stale_claim_as_current: answer describes "${event.headline}" as current, but its record is past the freshness policy`,
      );
    }
  }

  // --- Rule 3: guarantee language ------------------------------------------
  for (const pattern of GUARANTEE_PATTERNS) {
    if (pattern.test(text)) {
      violations.push(`guarantee_language: answer matches ${pattern}`);
    }
  }

  // --- Rule 4: contradicting an active evacuation order ---------------------
  const activeEvacuation = evidence.events.some(
    (e) => e.event_type === "evacuation_order" && e.status === "active",
  );
  if (activeEvacuation && STAY_PUT.test(text)) {
    violations.push(
      "contradicts_evacuation_order: an active evacuation order is in evidence but the answer advises staying put",
    );
  }

  // --- Rule 5: provenance and freshness must be present ---------------------
  const freshnessMissing = !response.freshness_note || response.freshness_note.trim() === "";
  if (freshnessMissing) {
    violations.push("missing_freshness_note: response has no freshness note");
  }
  if (response.sources.length === 0) {
    // A genuine "nothing is verified" answer has nothing to cite. That is
    // allowed only when the answer says so and makes no operational claims.
    const disclaims = NO_DATA_DISCLAIMER.test(answer) && claimWords.size === 0;
    if (!disclaims) {
      violations.push("missing_sources: response cites no sources");
    }
  }

  return { ok: violations.length === 0, violations };
}
