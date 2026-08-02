import {
  SEVERITY_RANK,
  TIER_WEIGHT,
  confidenceLabel,
  geometryCentroid,
  type CanonicalEvent,
  type Certainty,
  type SourceTier,
  type Urgency,
} from "@harborline/event-schema";

const URGENCY_RANK: Record<Urgency, number> = {
  immediate: 4,
  expected: 3,
  future: 2,
  past: 1,
  unknown: 0,
};

const CERTAINTY_RANK: Record<Certainty, number> = {
  observed: 4,
  likely: 3,
  possible: 2,
  unlikely: 1,
  unknown: 0,
};

/** UTC day bucket, e.g. "2026-08-02". */
function dayBucket(iso: string | null): string {
  if (!iso) return "undated";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "undated" : d.toISOString().slice(0, 10);
}

/**
 * Identity key for cross-provider deduplication:
 * event type + centroid rounded to ~110 m + the day the event started.
 *
 * Two providers describing the same flood on the same block on the same day
 * collapse to one event; the same street a kilometre away does not.
 */
export function dedupKey(e: CanonicalEvent): string {
  const [lon, lat] = geometryCentroid(e.geometry);
  const round = (n: number) => n.toFixed(3);
  return [
    e.event_type,
    round(lon),
    round(lat),
    dayBucket(e.starts_at ?? e.last_verified_at),
  ].join("|");
}

function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function betterTier(a: SourceTier, b: SourceTier): SourceTier {
  return TIER_WEIGHT[a] >= TIER_WEIGHT[b] ? a : b;
}

function preferText(primary: string, fallback: string): string {
  const p = primary.trim();
  return p === "" ? fallback : p;
}

/**
 * Merge two records of the same real-world event.
 *
 * Non-destructive by construction: the widest time window, the strongest
 * severity/urgency/certainty, the highest authority tier, and any
 * contradiction note are all retained. Provenance is never dropped —
 * `source_count` and the SourceRecord set are owned by the store, so this
 * function leaves `source_count` alone.
 */
export function mergeEvents(
  existing: CanonicalEvent,
  incoming: CanonicalEvent,
): CanonicalEvent {
  const best_tier = betterTier(existing.best_tier, incoming.best_tier);
  const incomingIsNewer =
    new Date(incoming.last_verified_at).getTime() >
    new Date(existing.last_verified_at).getTime();
  const incomingWeight = TIER_WEIGHT[incoming.best_tier];
  const existingWeight = TIER_WEIGHT[existing.best_tier];
  // Narrative fields come from the highest-authority record, and among equals
  // from the freshest one.
  const preferIncoming =
    incomingWeight > existingWeight ||
    (incomingWeight === existingWeight && incomingIsNewer);

  const authoritative = preferIncoming ? incoming : existing;
  const secondary = preferIncoming ? existing : incoming;

  const severity =
    SEVERITY_RANK[incoming.severity] > SEVERITY_RANK[existing.severity]
      ? incoming.severity
      : existing.severity;
  const urgency =
    URGENCY_RANK[incoming.urgency] > URGENCY_RANK[existing.urgency]
      ? incoming.urgency
      : existing.urgency;
  const certainty =
    CERTAINTY_RANK[incoming.certainty] > CERTAINTY_RANK[existing.certainty]
      ? incoming.certainty
      : existing.certainty;

  const confidence_score = Math.max(existing.confidence_score, incoming.confidence_score);

  return {
    event_id: existing.event_id,
    event_type: existing.event_type,
    headline: preferText(authoritative.headline, secondary.headline),
    description: preferText(authoritative.description, secondary.description),
    instructions: authoritative.instructions ?? secondary.instructions ?? null,
    severity,
    urgency,
    certainty,
    // A newer, at-least-as-authoritative record may cancel or expire the event.
    status: authoritative.status,
    geometry: authoritative.geometry,
    starts_at: earliest(existing.starts_at, incoming.starts_at),
    ends_at: latest(existing.ends_at, incoming.ends_at),
    last_verified_at:
      latest(existing.last_verified_at, incoming.last_verified_at) ??
      existing.last_verified_at,
    // Owned by the store, which counts distinct source records.
    source_count: existing.source_count,
    best_tier,
    confidence_score,
    confidence_label: confidenceLabel(confidence_score, best_tier),
    contradiction_note: existing.contradiction_note ?? incoming.contradiction_note ?? null,
  };
}
