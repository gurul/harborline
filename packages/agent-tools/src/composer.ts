/**
 * Deterministic response composer.
 *
 * Language restates structured evidence; it never originates a fact. Every
 * operational claim in the answer traces to a record in the bundle, and every
 * record's age is stated inline. The composer is constructed so its output
 * always passes `validateResponse`.
 */
import {
  type AccessNeed,
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
  observationMaxAge,
  resourceMaxAge,
} from "@harborline/event-schema";
import { needMet, needsFromQuestion, planQuery, rankResources, type QueryIntent } from "./planner.js";
import {
  HAZARD_EVENT_TYPES,
  type EnvironmentSummary,
  type ResourceCaution,
} from "./tools.js";
import { satelliteDisclosure } from "./router.js";

/** Fraction of the freshness budget past which a record is "aging". */
export const NEAR_STALE_RATIO = 0.75;

export interface RejectedResource {
  resource: NearbyResource;
  rejected_reason: string;
}

export interface EvidenceBundle {
  /**
   * The question type the evidence was gathered for. Set by `gatherEvidence`
   * so the composer answers the same question even when a request parameter
   * (a chosen shelter) decided it. Hand-built bundles may omit it.
   */
  intent?: QueryIntent;
  events: CanonicalEvent[];
  /** Air quality, gauge, smoke, fire and power summary for fire and air questions. */
  environment?: EnvironmentSummary;
  /** How shelters were ranked: stated needs and a caller-chosen shelter. */
  ranking?: {
    access_needs: AccessNeed[];
    requested_resource_id?: string;
    requested_status?: "selected" | "not_recommendable" | "unknown";
  };
  resources?: NearbyResource[];
  rejected_resources?: RejectedResource[];
  /** Unconfirmed hazards near recommendable resources (satellite detections). */
  resource_cautions?: ResourceCaution[];
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
  // A satellite pixel is a detection, not a verification by anyone.
  if (event.event_type === "fire_detection") {
    const by = providers.length > 0 ? providers.join(", ") : `tier ${event.best_tier} record`;
    return `${by}, detected by satellite ${age}, unconfirmed by a fire agency`;
  }
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

  // Satellite detections can number in the dozens: one source per provider
  // and URL, carrying the newest detection time, instead of one per cluster.
  const detectionIds = new Set(
    evidence.events.filter((e) => e.event_type === "fire_detection").map((e) => e.event_id),
  );
  const collapsed = new Map<string, AssistantSource>();
  for (const record of evidence.source_records ?? []) {
    const source: AssistantSource = {
      provider: record.provider,
      tier: record.provider_tier,
      url: record.source_url,
      last_verified_at: record.published_at,
    };
    if (record.event_id && detectionIds.has(record.event_id)) {
      const key = `${source.provider}|${source.tier}|${source.url ?? ""}`;
      const prior = collapsed.get(key);
      if (!prior || new Date(source.last_verified_at).getTime() > new Date(prior.last_verified_at).getTime()) {
        collapsed.set(key, source);
      }
      continue;
    }
    push(source);
  }
  for (const source of collapsed.values()) push(source);
  for (const source of evidence.environment?.sources ?? []) push(source);

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
  const env = evidence.environment;
  for (const section of [env?.air_quality, env?.stream_gauge, env?.smoke]) {
    if (section?.last_verified_at) consider(section.last_verified_at);
  }
  return best;
}

/** True when the environment summary holds any reading or a healthy fire feed. */
function hasEnvironmentEvidence(evidence: EvidenceBundle): boolean {
  const env = evidence.environment;
  if (!env) return false;
  return (
    env.air_quality.status !== "no_data" ||
    env.stream_gauge.status !== "no_data" ||
    env.smoke.status !== "no_data" ||
    env.fire.status === "ok" ||
    env.power.status === "outage_reported"
  );
}

export function hasEvidence(evidence: EvidenceBundle): boolean {
  return (
    evidence.events.length > 0 ||
    (evidence.resources?.length ?? 0) > 0 ||
    (evidence.rejected_resources?.length ?? 0) > 0 ||
    hasEnvironmentEvidence(evidence)
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
  const env = evidence.environment;
  if (env?.air_quality.last_verified_at) {
    flagAge(`Air quality at ${env.air_quality.name}`, env.air_quality.last_verified_at, observationMaxAge("air_quality"));
  }
  if (env?.smoke.last_verified_at) {
    flagAge("Satellite smoke analysis", env.smoke.last_verified_at, observationMaxAge("smoke"));
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
    route.candidates.every((c) => c.eliminated &&
      (c.rejected_reason === "closure_intersection" ||
        c.rejected_reason === "evacuation_zone" ||
        c.rejected_reason === "hazard_zone"))
  ) {
    lines.push(
      "No route is currently verified as passable. If leaving by road is not possible, " +
        "do not wait in a vehicle in the hazard's path: move to the nearest large cleared, " +
        "non-vegetated open area — a large parking lot, sports field, or wide paved area — " +
        "and re-check for an updated route.",
    );
  } else if (!route.recommendation) {
    lines.push("A route to this destination is not verified by the demonstration graph. Confirm directions with local authorities before travelling.");
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
      // An unconfirmed satellite pixel never triggers "act now".
      event.event_type !== "fire_detection" &&
      event.urgency === "immediate" &&
      (event.severity === "severe" || event.severity === "extreme"),
  );
  if (!pressing) return null;
  return (
    `**${pressing.headline}** is marked immediate by its issuing source: ` +
    "act on current conditions now rather than waiting for a zone-by-zone instruction."
  );
}

const NEED_LABEL: Record<AccessNeed, string> = {
  wheelchair: "wheelchair access",
  accessible_restroom: "accessible restroom",
  pets: "pets",
};

/** Needs applied to the ranking: stated ones plus those the question names. */
export function appliedNeeds(question: string, evidence: EvidenceBundle): AccessNeed[] {
  return [...new Set([...needsFromQuestion(question), ...(evidence.ranking?.access_needs ?? [])])];
}

/** "Ranked for ...": what the chosen shelter's record says about each need. */
function accessNeedsLine(evidence: EvidenceBundle, top: NearbyResource): string | null {
  const needs = evidence.ranking?.access_needs ?? [];
  if (needs.length === 0) return null;
  const parts = needs.map((need) => {
    const met = needMet(top, need);
    const state = met === true ? "recorded" : met === false ? "not offered per its record" : "not recorded";
    return `${NEED_LABEL[need]}: ${state}`;
  });
  return `Ranked for your access needs. This shelter's record: ${parts.join("; ")}.`;
}

function requestedShelterLine(evidence: EvidenceBundle): string | null {
  const ranking = evidence.ranking;
  if (!ranking?.requested_resource_id) return null;
  if (ranking.requested_status === "selected") return null;
  if (ranking.requested_status === "not_recommendable") {
    const item = (evidence.rejected_resources ?? []).find(
      (r) => r.resource.resource_id === ranking.requested_resource_id,
    );
    const phrase = item ? REJECTION_PHRASE[item.rejected_reason] ?? item.rejected_reason : "not recommendable";
    const name = item?.resource.name ?? "The shelter you selected";
    return `${name}, the shelter you selected, is excluded right now (${phrase}). The best other option is shown instead.`;
  }
  return "The shelter you selected is not in the current records. The best available option is shown instead.";
}

function cautionsFor(evidence: EvidenceBundle, resourceId: string): ResourceCaution[] {
  return (evidence.resource_cautions ?? []).filter((c) => c.resource_id === resourceId);
}

function composeNearestShelter(evidence: EvidenceBundle, now: Date): string[] {
  const recommendable = evidence.resources ?? [];
  const rejected = evidence.rejected_resources ?? [];
  const lines: string[] = [];

  const requestedLine = requestedShelterLine(evidence);
  if (requestedLine) lines.push(requestedLine);

  if (recommendable.length === 0) {
    lines.push(
      "No verified reports of an available shelter near you. Nothing in the current records confirms an available location.",
    );
  } else {
    const top = recommendable[0]!;
    const needsLine = accessNeedsLine(evidence, top);
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
    if (needsLine) lines.push(`- ${needsLine}`);
    for (const caution of cautionsFor(evidence, top.resource_id)) {
      lines.push(`- Caution: ${caution.note}.`);
    }

    // Camp Fire lesson (benchmark criterion 11): shelters overflowed and
    // arrivals had no plan B — name the fallback destination explicitly.
    recommendable.slice(1).forEach((other, index) => {
      const advisory = other.health_advisory
        ? ` Health advisory: ${other.health_advisory}.`
        : "";
      const caution = cautionsFor(evidence, other.resource_id)
        .map((c) => ` Caution: ${c.note}.`)
        .join("");
      const base = `${other.name}, ${distanceLabel(other.distance_m)} away (verified ${formatAge(
        other.last_verified_at,
        now,
      )}, ${other.provider}).${advisory}${caution}`;
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

function kmLabel(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Limits of satellite fire data, stated with every fire answer. */
export const FIRE_LIMITS_LINE =
  "Limits: satellites pass only a few times a day, cloud and smoke can hide a fire, and a missing detection is not evidence that an area is clear. Follow official fire agency updates.";

function smokeLine(env: EnvironmentSummary): string | null {
  const smoke = env.smoke;
  if (smoke.status === "no_data") return null;
  const where = smoke.over_point ? "over this location" : `${kmLabel(smoke.distance_m ?? 0)} away`;
  if (smoke.status === "stale") {
    return `The last satellite smoke analysis (${smoke.provider}) is from ${smoke.age_label}; there is no current analysis.`;
  }
  return `Satellite smoke analysis shows ${smoke.density} smoke ${where} (${smoke.provider}, analysed ${smoke.age_label}).`;
}

function composeFireNearby(
  evidence: EvidenceBundle,
  byEvent: Map<string, SourceRecord[]>,
  now: Date,
): string[] {
  const env = evidence.environment;
  const radius = env?.radius_m ?? 25_000;
  const lines: string[] = [];
  const official = evidence.events.filter(
    (e) =>
      e.event_type === "fire" ||
      e.event_type === "fire_perimeter" ||
      e.event_type === "evacuation_order" ||
      (e.event_type === "weather_warning" && /fire|red flag|smoke/i.test(e.headline)),
  );
  if (official.length > 0) {
    lines.push(`Official fire and evacuation records within ${kmLabel(radius)}:`);
    for (const event of official.slice(0, 6)) {
      lines.push(
        `- **${event.headline}** — ${event.event_type.replace(/_/g, " ")}, ${event.severity} (${attribution(event, byEvent, now)}).`,
      );
      if (event.instructions) lines.push(`  Official instructions: ${event.instructions}`);
    }
  }

  const fire = env?.fire;
  if (fire && fire.status === "ok" && fire.detections > 0) {
    lines.push(
      `${fire.detections} satellite heat detection cluster${fire.detections === 1 ? "" : "s"} within ${kmLabel(radius)}: ` +
        `nearest ${kmLabel(fire.nearest_distance_m ?? 0)}, newest detected ${fire.newest_age_label} ` +
        `(VIIRS on NOAA-20 and NOAA-21). Unconfirmed by a fire agency.`,
    );
  } else if (fire && fire.status === "ok") {
    lines.push(
      `No verified reports of a satellite heat detection within ${kmLabel(radius)} in the last 24 h.`,
    );
  } else {
    lines.push("Satellite fire data is not available right now, so the fire picture here is incomplete.");
  }

  if (env) {
    const smoke = smokeLine(env);
    if (smoke) lines.push(smoke);
  }
  lines.push(FIRE_LIMITS_LINE);
  return lines;
}

/** EPA guidance by AQI category. Fixed text, never model output. */
export const AIR_ACTION: Record<string, string> = {
  Good: "Air quality is in the Good range at the reporting monitor. Re-check before long outdoor activity; readings update hourly.",
  Moderate: "Unusually sensitive people should consider reducing long or heavy outdoor exertion (EPA guidance for Moderate).",
  "Unhealthy for Sensitive Groups":
    "People with heart or lung disease, older adults, children and pregnant people should reduce long or heavy outdoor exertion (EPA guidance for this category).",
  Unhealthy:
    "Everyone should reduce long or heavy outdoor exertion; sensitive groups should avoid it (EPA guidance for Unhealthy).",
  "Very Unhealthy":
    "Everyone should avoid long or heavy outdoor exertion; sensitive groups should remain indoors with windows shut (EPA guidance for Very Unhealthy).",
  Hazardous:
    "Everyone should avoid all physical activity outdoors and keep windows shut where possible (EPA guidance for Hazardous).",
};

function composeAir(evidence: EvidenceBundle, byEvent: Map<string, SourceRecord[]>, now: Date): string[] {
  const env = evidence.environment;
  const radius = env?.radius_m ?? 25_000;
  const lines: string[] = [];
  const aq = env?.air_quality;
  if (!aq || aq.status === "no_data") {
    lines.push(`No verified reports of air quality within ${kmLabel(radius)} right now.`);
  } else if (aq.status === "stale") {
    lines.push(
      `The last air-quality reading near you is from **${aq.name}**, ${aq.age_label} (${aq.provider}): ` +
        `AQI ${aq.aqi}, ${aq.category} at that time. There is no current reading.`,
    );
  } else {
    lines.push(
      `Air quality at **${aq.name}** (${kmLabel(aq.distance_m ?? 0)} away): AQI ${aq.aqi}, ${aq.category}, ` +
        `main pollutant ${aq.pollutant}. Reported ${aq.age_label} by ${aq.provider}.`,
    );
    lines.push("The reading is for the monitor's reporting area, not your exact location.");
  }
  if (env) {
    const smoke = smokeLine(env);
    if (smoke) lines.push(smoke);
  }
  const alerts = evidence.events.filter((e) => e.event_type === "weather_warning" || e.event_type === "evacuation_order");
  for (const event of alerts.slice(0, 3)) {
    lines.push(`- **${event.headline}** (${attribution(event, byEvent, now)}).`);
    if (event.instructions) lines.push(`  Official instructions: ${event.instructions}`);
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
    case "fire_nearby":
      return composeFireNearby(evidence, byEvent, now);
    case "air_quality":
      return composeAir(evidence, byEvent, now);
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
      if (!rec) {
        return "A route to this shelter is not verified. Contact local emergency services for directions and re-check for updates before travelling.";
      }
      const chosen = evidence.route?.candidates.find((c) => c.route_id === rec.route_id);
      const crossed = chosen?.intersecting_event_ids.length ?? 0;
      const satellite = chosen ? satelliteDisclosure(chosen, evidence.events, now).trim() : "";
      const crossing = crossed > 0
        ? ` It passes through or near ${crossed} reported hazard area${crossed === 1 ? "" : "s"}.` +
          (satellite ? ` ${satellite}` : "")
        : "";
      return `Head for ${top.name} using the lowest-risk route currently available (about ${Math.max(
        1,
        Math.round(rec.duration_min),
      )} min).${crossing} Re-check before you leave — this reflects reports as of ${formatAge(
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
    case "fire_nearby": {
      if (evidence.events.some((e) => e.event_type === "evacuation_order" && e.status === "active")) {
        return "Follow the evacuation order above and leave by the route officials give.";
      }
      if (evidence.events.some((e) => e.event_type === "fire" || e.event_type === "fire_perimeter")) {
        return "Follow the fire agency's instructions and re-check for updates; be ready to leave if an order is issued.";
      }
      if ((evidence.environment?.fire.detections ?? 0) > 0) {
        return "Treat satellite detections as unconfirmed: check official fire agency updates and be ready to leave if an order is issued.";
      }
      return "Keep checking official fire agency updates; satellite coverage has gaps of several hours.";
    }
    case "air_quality": {
      if (evidence.events.some((e) => e.event_type === "evacuation_order" && e.status === "active")) {
        return "An evacuation order is in effect nearby: follow it before any air-quality advice.";
      }
      const aq = evidence.environment?.air_quality;
      if (aq?.status === "ok" && aq.category && AIR_ACTION[aq.category]) return AIR_ACTION[aq.category]!;
      return "There is no current reading: check your local air agency before planning time outdoors.";
    }
    case "area_status":
    case "general":
      return "Follow the official instructions above and re-check for updates.";
  }
}

/**
 * Camp Fire lesson (benchmark criterion 10): the victims skewed elderly and
 * mobility-limited. When the question itself asks about accessibility, a
 * verified-accessible shelter outranks a marginally nearer one with no
 * recorded accessibility features. Records only — nothing is inferred.
 */
function alignDestination(
  question: string,
  evidence: EvidenceBundle,
): EvidenceBundle {
  const ranking = evidence.ranking;
  const resources = rankResources(question, evidence.resources ?? [], {
    access_needs: ranking?.access_needs,
    preferred_resource_id:
      ranking?.requested_status === "selected" ? ranking.requested_resource_id : undefined,
  });
  // Hand-built bundles may already carry a route to another resource. Never
  // transfer that route's duration or guidance to the newly selected shelter.
  const destinationId = evidence.route?.recommendation?.destination_resource_id ??
    evidence.route?.destination?.resource_id;
  const route = destinationId && destinationId !== resources[0]?.resource_id
    ? undefined : evidence.route;
  return { ...evidence, resources, route };
}

export function composeResponse(
  question: string,
  evidence: EvidenceBundle,
  now: Date,
): AssistantResponse {
  const intent = evidence.intent ?? planQuery(question).intent;
  evidence = alignDestination(question, evidence);
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
    ...answerRoute(intent, evidence),
    access_needs_applied: intent === "nearest_shelter" ? appliedNeeds(question, evidence) : [],
  };
}

/**
 * The destination and route an answer recommends. Taken from the aligned
 * bundle, so the route always ends at the shelter the answer names.
 */
export function answerRoute(
  intent: QueryIntent,
  evidence: EvidenceBundle,
): Pick<AssistantResponse, "destination_resource_id" | "route"> {
  if (intent !== "nearest_shelter") return { destination_resource_id: null, route: null };
  const top = (evidence.resources ?? [])[0];
  const rec = evidence.route?.recommendation ?? null;
  const candidate = rec ? evidence.route?.candidates.find((c) => c.route_id === rec.route_id) : undefined;
  return {
    destination_resource_id: top?.resource_id ?? null,
    route:
      rec && candidate && top && rec.destination_resource_id === top.resource_id
        ? { recommendation: rec, candidate }
        : null,
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
