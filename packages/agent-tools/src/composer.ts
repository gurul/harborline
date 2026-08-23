/**
 * Deterministic response composer.
 *
 * Language restates structured evidence; it never originates a fact. Every
 * operational claim in the answer traces to a record in the bundle, and every
 * record's age is stated inline. The composer is constructed so its output
 * always passes `validateResponse`.
 */
import {
  type AssistantResponse,
  type AssistantSource,
  type CanonicalEvent,
  type NearbyResource,
  type Resource,
  type RouteCandidate,
  type RouteRecommendation,
  type SourceRecord,
  type SourceTier,
  ageSeconds,
  eventMaxAge,
  formatAge,
  isStale,
  resourceMaxAge,
} from "@harborline/event-schema";
import { planQuery, type QueryIntent } from "./planner.js";
import { HAZARD_EVENT_TYPES } from "./tools.js";

/** Fraction of the freshness budget past which a record is "aging". */
export const NEAR_STALE_RATIO = 0.75;

export interface RejectedResource {
  resource: NearbyResource;
  rejected_reason: string;
}

export interface EvidenceBundle {
  events: CanonicalEvent[];
  resources?: NearbyResource[];
  rejected_resources?: RejectedResource[];
  route?: {
    candidates: RouteCandidate[];
    recommendation: RouteRecommendation | null;
    destination?: Resource;
  };
  source_records?: SourceRecord[];
}

// ---------------------------------------------------------------------------
// Evidence helpers (exported — the validator and the LLM path reuse them so all
// three agree on what the bundle says).
// ---------------------------------------------------------------------------

export function recordsByEvent(evidence: EvidenceBundle): Map<string, SourceRecord[]> {
  const map = new Map<string, SourceRecord[]>();
  for (const record of evidence.source_records ?? []) {
    if (!record.event_id) continue;
    const list = map.get(record.event_id);
    if (list) list.push(record);
    else map.set(record.event_id, [record]);
  }
  return map;
}

function providersFor(eventId: string, byEvent: Map<string, SourceRecord[]>): string[] {
  return [...new Set((byEvent.get(eventId) ?? []).map((r) => r.provider))];
}

/** Attribution line for an event: providers when known, tier otherwise. */
function attribution(
  event: CanonicalEvent,
  byEvent: Map<string, SourceRecord[]>,
  now: Date,
): string {
  const providers = providersFor(event.event_id, byEvent);
  const age = formatAge(event.last_verified_at, now);
  return providers.length > 0
    ? `${providers.join(", ")}, verified ${age}`
    : `tier ${event.best_tier} record, verified ${age}`;
}

export function buildSources(evidence: EvidenceBundle): AssistantSource[] {
  const out: AssistantSource[] = [];
  const seen = new Set<string>();

  const push = (source: AssistantSource) => {
    const key = `${source.provider}|${source.tier}|${source.last_verified_at}|${source.url ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(source);
  };

  for (const record of evidence.source_records ?? []) {
    push({
      provider: record.provider,
      tier: record.provider_tier,
      url: record.source_url,
      last_verified_at: record.published_at,
    });
  }

  for (const resource of evidence.resources ?? []) {
    push({
      provider: resource.provider,
      tier: resource.provider_tier,
      url: resource.source_url,
      last_verified_at: resource.last_verified_at,
    });
  }
  for (const rejected of evidence.rejected_resources ?? []) {
    push({
      provider: rejected.resource.provider,
      tier: rejected.resource.provider_tier,
      url: rejected.resource.source_url,
      last_verified_at: rejected.resource.last_verified_at,
    });
  }

  // Fallback: an event with no accompanying source record still has real,
  // non-invented provenance — its authority tier and verification time. We
  // surface that rather than dropping the attribution entirely. Callers should
  // pass source_records so the true provider name is shown instead.
  if (out.length === 0) {
    for (const event of evidence.events) {
      push({
        provider: `Harborline verified record (tier ${event.best_tier})`,
        tier: event.best_tier,
        url: null,
        last_verified_at: event.last_verified_at,
      });
    }
  }

  return out;
}

export function newestVerifiedAt(evidence: EvidenceBundle): string | null {
  let best: string | null = null;
  const consider = (iso: string) => {
    if (best === null || new Date(iso).getTime() > new Date(best).getTime()) best = iso;
  };
  for (const event of evidence.events) consider(event.last_verified_at);
  for (const resource of evidence.resources ?? []) consider(resource.last_verified_at);
  for (const rejected of evidence.rejected_resources ?? []) {
    consider(rejected.resource.last_verified_at);
  }
  for (const record of evidence.source_records ?? []) consider(record.published_at);
  return best;
}

export function hasEvidence(evidence: EvidenceBundle): boolean {
  return (
    evidence.events.length > 0 ||
    (evidence.resources?.length ?? 0) > 0 ||
    (evidence.rejected_resources?.length ?? 0) > 0
  );
}

interface UncertaintyFlags {
  lowTier: SourceTier[];
  aging: string[];
  contradictions: string[];
}

export function uncertaintyFlags(evidence: EvidenceBundle, now: Date): UncertaintyFlags {
  const lowTier = new Set<SourceTier>();
  const aging: string[] = [];
  const contradictions: string[] = [];

  const flagAge = (label: string, lastVerifiedAt: string, maxAge: number) => {
    const ratio = ageSeconds(lastVerifiedAt, now) / Math.max(maxAge, 1);
    if (ratio >= NEAR_STALE_RATIO) aging.push(`${label} (${formatAge(lastVerifiedAt, now)})`);
  };

  for (const event of evidence.events) {
    if (event.best_tier === "D" || event.best_tier === "E") lowTier.add(event.best_tier);
    flagAge(event.headline, event.last_verified_at, eventMaxAge(event.event_type));
    if (event.contradiction_note) contradictions.push(event.contradiction_note);
  }
  for (const record of evidence.source_records ?? []) {
    if (record.provider_tier === "D" || record.provider_tier === "E") {
      lowTier.add(record.provider_tier);
    }
  }
  for (const resource of evidence.resources ?? []) {
    if (resource.provider_tier === "D" || resource.provider_tier === "E") {
      lowTier.add(resource.provider_tier);
    }
    flagAge(resource.name, resource.last_verified_at, resourceMaxAge(resource.resource_type));
  }
  for (const rejected of evidence.rejected_resources ?? []) {
    flagAge(
      rejected.resource.name,
      rejected.resource.last_verified_at,
      resourceMaxAge(rejected.resource.resource_type),
    );
  }

  return { lowTier: [...lowTier], aging, contradictions };
}

export function buildUncertaintyNote(
  evidence: EvidenceBundle,
  now: Date,
): string | null {
  const flags = uncertaintyFlags(evidence, now);
  const parts: string[] = [];
  if (flags.contradictions.length > 0) {
    parts.push(`Conflicting reports: ${flags.contradictions.join("; ")}`);
  }
  if (flags.lowTier.length > 0) {
    parts.push(
      `Some evidence comes from unverified or community sources (tier ${flags.lowTier
        .sort()
        .join(", ")}) and has not been confirmed by an authority.`,
    );
  }
  if (flags.aging.length > 0) {
    parts.push(`Nearing the freshness limit: ${flags.aging.join("; ")}.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

export function buildFreshnessNote(evidence: EvidenceBundle, now: Date): string {
  const newest = newestVerifiedAt(evidence);
  if (!newest) return "No verified sources available for this area.";
  return `Most recent source updated ${formatAge(newest, now)}.`;
}

// ---------------------------------------------------------------------------
// Answer templates
// ---------------------------------------------------------------------------

const REJECTION_PHRASE: Record<string, string> = {
  stale_status: "status not re-confirmed recently",
  full: "reported at capacity",
  closed: "not confirmed open",
  inside_hazard_zone: "inside an active hazard area",
};

function capacityLine(resource: NearbyResource): string | null {
  if (resource.capacity_available === null || resource.capacity_total === null) return null;
  return `Capacity: ${resource.capacity_available} of ${resource.capacity_total} spaces reported available`;
}

function distanceLabel(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

function routeSection(evidence: EvidenceBundle): string[] {
  const route = evidence.route;
  if (!route) return [];
  const lines: string[] = [];
  if (route.recommendation) {
    lines.push(route.recommendation.summary);
  }
  const eliminated = route.candidates.filter((c) => c.eliminated);
  if (eliminated.length > 0) {
    const reasons = [...new Set(eliminated.map((c) => c.rejected_reason ?? "unknown"))];
    lines.push(
      `${eliminated.length} of ${route.candidates.length} route option${
        route.candidates.length === 1 ? "" : "s"
      } removed from consideration (${reasons.join(", ")}).`,
    );
  }
  // Camp Fire lesson (benchmark criterion 3): when every candidate is cut,
  // say so plainly and give refuge-in-place direction instead of silence.
  // NIST TN 2252 documents 31 improvised temporary refuge areas — parking
  // lots and cleared ground — holding 1,200+ people whose routes had closed.
  if (
    !route.recommendation &&
    route.candidates.length > 0 &&
    route.candidates.every((c) => c.eliminated)
  ) {
    lines.push(
      "No route is currently verified as passable. If leaving by road is not possible, " +
        "do not wait in a vehicle in the hazard's path: move to the nearest large cleared, " +
        "non-vegetated open area — a large parking lot, sports field, or wide paved area — " +
        "and re-check for an updated route.",
    );
  }
  if (route.candidates.length > 0) {
    lines.push("Routing is a bounded demonstration graph, not a live traffic service.");
  }
  return lines;
}

/**
 * Camp Fire lesson (benchmark criterion 6): the fire outran the staged
 * zone-by-zone ordering — it entered Paradise at 07:44, two minutes before the
 * town's first zone order. When an active blocking hazard is marked
 * `immediate` by its issuing source, say plainly that current conditions,
 * not the arrival of a zone instruction, are the trigger to act.
 */
export function immediateHazardNote(evidence: EvidenceBundle): string | null {
  const pressing = evidence.events.find(
    (event) =>
      event.status === "active" &&
      HAZARD_EVENT_TYPES.includes(event.event_type) &&
      event.urgency === "immediate" &&
      (event.severity === "severe" || event.severity === "extreme"),
  );
  if (!pressing) return null;
  return (
    `**${pressing.headline}** is marked immediate by its issuing source: ` +
    "act on current conditions now rather than waiting for a zone-by-zone instruction."
  );
}

function composeNearestShelter(evidence: EvidenceBundle, now: Date): string[] {
  const recommendable = evidence.resources ?? [];
  const rejected = evidence.rejected_resources ?? [];
  const lines: string[] = [];

  if (recommendable.length === 0) {
    lines.push(
      "No verified reports of an available shelter near you. Nothing in the current records confirms an available location.",
    );
  } else {
    const top = recommendable[0]!;
    lines.push(
      `The nearest open shelter is **${top.name}** (verified ${formatAge(
        top.last_verified_at,
        now,
      )}, ${top.provider}), ${distanceLabel(top.distance_m)} away.`,
    );
    const details: string[] = [];
    const cap = capacityLine(top);
    if (cap) details.push(cap);
    if (top.address) details.push(`Address: ${top.address}`);
    // Camp Fire lesson (benchmark criterion 7): four shelters ran a norovirus
    // outbreak while officially open — a health advisory is surfaced, never
    // hidden behind an "open" status.
    if (top.health_advisory) details.push(`Health advisory: ${top.health_advisory}`);
    if (top.accessibility_features.length > 0) {
      details.push(`Accessibility: ${top.accessibility_features.join(", ")}`);
    }
    if (top.pet_policy) details.push(`Pets: ${top.pet_policy}`);
    if (top.contact_information) details.push(`Contact: ${top.contact_information}`);
    for (const d of details) lines.push(`- ${d}`);

    // Camp Fire lesson (benchmark criterion 11): shelters overflowed and
    // arrivals had no plan B — name the fallback destination explicitly.
    recommendable.slice(1).forEach((other, index) => {
      const advisory = other.health_advisory
        ? ` Health advisory: ${other.health_advisory}.`
        : "";
      const base = `${other.name}, ${distanceLabel(other.distance_m)} away (verified ${formatAge(
        other.last_verified_at,
        now,
      )}, ${other.provider}).${advisory}`;
      lines.push(
        index === 0
          ? `- If it is full when you arrive, next option: ${base}`
          : `- Also available: ${base}`,
      );
    });
  }

  if (rejected.length > 0) {
    lines.push("Excluded from recommendations:");
    for (const item of rejected) {
      const phrase = REJECTION_PHRASE[item.rejected_reason] ?? item.rejected_reason;
      lines.push(
        `- ${item.resource.name} — ${phrase}; last record ${formatAge(
          item.resource.last_verified_at,
          now,
        )} (${item.resource.provider}).`,
      );
    }
  }

  lines.push(...routeSection(evidence));
  return lines;
}

function composeRoadsToAvoid(
  evidence: EvidenceBundle,
  byEvent: Map<string, SourceRecord[]>,
  now: Date,
): string[] {
  const relevant = evidence.events.filter((e) =>
    HAZARD_EVENT_TYPES.includes(e.event_type),
  );
  if (relevant.length === 0) {
    return [
      "No verified reports of a road closure or blocking hazard in this area right now.",
    ];
  }
  const lines = ["Reported closures and hazards affecting travel:"];
  for (const event of relevant) {
    lines.push(
      `- **${event.headline}** — ${event.event_type.replace(/_/g, " ")}, ${event.severity} (${attribution(
        event,
        byEvent,
        now,
      )}).`,
    );
    if (event.description) lines.push(`  ${event.description}`);
    if (event.contradiction_note) lines.push(`  Conflicting report: ${event.contradiction_note}`);
  }
  lines.push(...routeSection(evidence));
  return lines;
}

function composeWhatChanged(
  evidence: EvidenceBundle,
  byEvent: Map<string, SourceRecord[]>,
  now: Date,
): string[] {
  if (evidence.events.length === 0) {
    return ["No verified records have been updated for this area in the recent window."];
  }
  const ordered = [...evidence.events].sort(
    (a, b) =>
      new Date(b.last_verified_at).getTime() - new Date(a.last_verified_at).getTime(),
  );
  const lines = ["Most recently updated records for this area:"];
  for (const event of ordered.slice(0, 5)) {
    lines.push(`- **${event.headline}** — ${attribution(event, byEvent, now)}.`);
  }
  return lines;
}

function composeAreaStatus(
  evidence: EvidenceBundle,
  byEvent: Map<string, SourceRecord[]>,
  now: Date,
): string[] {
  if (evidence.events.length === 0) {
    return ["No verified reports are on record for this area right now."];
  }
  const counts = new Map<string, number>();
  for (const event of evidence.events) {
    counts.set(event.event_type, (counts.get(event.event_type) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([type, n]) => `${n} ${type.replace(/_/g, " ")}`)
    .join(", ");

  const lines = [`${evidence.events.length} active record(s) on file nearby: ${summary}.`];
  for (const event of evidence.events.slice(0, 4)) {
    lines.push(
      `- **${event.headline}** (${event.severity}, ${event.confidence_label}) — ${attribution(
        event,
        byEvent,
        now,
      )}.`,
    );
    if (event.instructions) lines.push(`  Official instructions: ${event.instructions}`);
  }
  return lines;
}

function composeResourceQuery(evidence: EvidenceBundle, now: Date): string[] {
  const resources = evidence.resources ?? [];
  if (resources.length === 0) {
    return ["No verified records for that kind of resource near you right now."];
  }
  const lines = ["Nearby resources on record:"];
  for (const resource of resources) {
    lines.push(
      `- **${resource.name}** (${resource.resource_type.replace(/_/g, " ")}) — ${
        resource.operational_status
      } as reported ${formatAge(resource.last_verified_at, now)}, ${distanceLabel(
        resource.distance_m,
      )} away (${resource.provider}).`,
    );
  }
  return lines;
}

function composeAnswer(
  intent: QueryIntent,
  evidence: EvidenceBundle,
  byEvent: Map<string, SourceRecord[]>,
  now: Date,
): string[] {
  const lines = composeAnswerBody(intent, evidence, byEvent, now);
  const urgent = immediateHazardNote(evidence);
  if (urgent) lines.push(urgent);
  return lines;
}

function composeAnswerBody(
  intent: QueryIntent,
  evidence: EvidenceBundle,
  byEvent: Map<string, SourceRecord[]>,
  now: Date,
): string[] {
  switch (intent) {
    case "nearest_shelter":
      return composeNearestShelter(evidence, now);
    case "roads_to_avoid":
      return composeRoadsToAvoid(evidence, byEvent, now);
    case "what_changed":
      return composeWhatChanged(evidence, byEvent, now);
    case "resource_query":
      return composeResourceQuery(evidence, now);
    case "area_status":
    case "general":
      return composeAreaStatus(evidence, byEvent, now);
  }
}

function recommendedAction(
  intent: QueryIntent,
  evidence: EvidenceBundle,
  now: Date,
): string | null {
  if (!hasEvidence(evidence)) return null;

  switch (intent) {
    case "nearest_shelter": {
      const top = (evidence.resources ?? [])[0];
      if (!top) return "Contact local emergency services — no shelter has been verified nearby.";
      const rec = evidence.route?.recommendation;
      return rec
        ? `Head for ${top.name} using the lowest-risk route currently available (about ${Math.max(
            1,
            Math.round(rec.duration_min),
          )} min). Re-check before you leave — this reflects reports as of ${formatAge(
            top.last_verified_at,
            now,
          )}.`
        : `Head for ${top.name} and confirm on arrival — this reflects reports as of ${formatAge(
            top.last_verified_at,
            now,
          )}.`;
    }
    case "roads_to_avoid":
      return "Plan around the listed closures and re-check before setting out; closure records change as crews report in.";
    case "what_changed":
      return "Re-check this feed shortly — records update as sources report in.";
    case "resource_query":
      return "Confirm with the operator before travelling; reported status can change without a new record.";
    case "area_status":
    case "general":
      return "Follow the official instructions above and re-check for updates.";
  }
}

const ACCESSIBILITY_QUERY = /\b(wheelchair|accessib\w*|ada|disab\w*|mobility)\b/i;

/**
 * Camp Fire lesson (benchmark criterion 10): the victims skewed elderly and
 * mobility-limited. When the question itself asks about accessibility, a
 * verified-accessible shelter outranks a marginally nearer one with no
 * recorded accessibility features. Records only — nothing is inferred.
 */
function preferAccessible(
  question: string,
  evidence: EvidenceBundle,
): EvidenceBundle {
  if (!ACCESSIBILITY_QUERY.test(question)) return evidence;
  const resources = [...(evidence.resources ?? [])].sort((a, b) => {
    const aRank = a.accessibility_features.length > 0 ? 0 : 1;
    const bRank = b.accessibility_features.length > 0 ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return a.distance_m - b.distance_m;
  });
  return { ...evidence, resources };
}

export function composeResponse(
  question: string,
  evidence: EvidenceBundle,
  now: Date,
): AssistantResponse {
  const { intent } = planQuery(question);
  evidence = preferAccessible(question, evidence);
  const byEvent = recordsByEvent(evidence);

  const lines = hasEvidence(evidence)
    ? composeAnswer(intent, evidence, byEvent, now)
    : [
        "No verified reports are available for this area right now. " +
          "Nothing in the current records supports an answer, and I will not guess.",
      ];

  const evidenceEventIds = [
    ...new Set([
      ...evidence.events.map((e) => e.event_id),
      ...(evidence.route?.recommendation?.evidence_event_ids ?? []),
    ]),
  ];

  return {
    answer_markdown: lines.join("\n"),
    recommended_action: recommendedAction(intent, evidence, now),
    sources: buildSources(evidence),
    freshness_note: buildFreshnessNote(evidence, now),
    uncertainty_note: buildUncertaintyNote(evidence, now),
    evidence_event_ids: evidenceEventIds,
    composed_by: "deterministic",
  };
}

/** Re-exported for callers that want the raw staleness check on a bundle. */
export function bundleHasStaleRecord(evidence: EvidenceBundle, now: Date): boolean {
  for (const event of evidence.events) {
    if (isStale(event.last_verified_at, eventMaxAge(event.event_type), now)) return true;
  }
  for (const resource of evidence.resources ?? []) {
    if (
      isStale(resource.last_verified_at, resourceMaxAge(resource.resource_type), now)
    ) {
      return true;
    }
  }
  return false;
}
