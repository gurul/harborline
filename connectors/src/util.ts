import {
  CanonicalEventSchema,
  computeConfidence,
  confidenceLabel,
  eventMaxAge,
  ageSeconds,
  type CanonicalEvent,
  type Certainty,
  type EventStatus,
  type EventType,
  type Geometry,
  type Severity,
  type SourceRecord,
  type SourceTier,
  type Urgency,
} from "@harborline/event-schema";

/**
 * Stable, dependency-free content hash (FNV-1a 32-bit, hex).
 * Used for SourceRecord.content_hash so re-fetching identical upstream payloads
 * is detectable without storing the payload twice.
 */
export function hashContent(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (keeps everything in int32 range).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // Mix in the length so short collisions are less likely.
  const mixed = (h ^ (s.length * 0x01000193)) >>> 0;
  return mixed.toString(16).padStart(8, "0");
}

/** ISO string, or null when the input is not a usable timestamp. */
export function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // ArcGIS / USGS emit epoch milliseconds.
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    // Numeric strings are epoch milliseconds.
    if (/^\d{10,}$/.test(trimmed)) {
      const d = new Date(Number(trimmed));
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function isoOffset(now: Date, offsetSeconds: number): string {
  return new Date(now.getTime() + offsetSeconds * 1000).toISOString();
}

export function minutesBefore(now: Date, minutes: number): string {
  return isoOffset(now, -minutes * 60);
}

export interface EventDraft {
  event_id: string;
  event_type: EventType;
  headline: string;
  description: string;
  instructions?: string | null;
  severity: Severity;
  urgency: Urgency;
  certainty: Certainty;
  status?: EventStatus;
  geometry: Geometry;
  starts_at: string | null;
  ends_at: string | null;
  last_verified_at: string;
  best_tier: SourceTier;
  source_count?: number;
  contradiction_note?: string | null;
  /** 1 = precise geometry, lower for zone/city-wide scope. */
  geographic_precision?: number;
  /** 1 = sources agree, lower when a source disputes the record. */
  consistency?: number;
}

/**
 * Build a validated CanonicalEvent, deriving confidence from tier + freshness
 * + corroboration. Every connector goes through this so scoring is uniform.
 */
export function makeEvent(draft: EventDraft, now: Date): CanonicalEvent {
  const sourceCount = draft.source_count ?? 1;
  const score = computeConfidence({
    tier: draft.best_tier,
    age_seconds: ageSeconds(draft.last_verified_at, now),
    max_age_seconds: eventMaxAge(draft.event_type),
    corroborating_sources: sourceCount,
    geographic_precision: draft.geographic_precision,
    consistency: draft.consistency,
  });

  return CanonicalEventSchema.parse({
    event_id: draft.event_id,
    event_type: draft.event_type,
    headline: draft.headline,
    description: draft.description,
    instructions: draft.instructions ?? null,
    severity: draft.severity,
    urgency: draft.urgency,
    certainty: draft.certainty,
    status: draft.status ?? "active",
    geometry: draft.geometry,
    starts_at: draft.starts_at,
    ends_at: draft.ends_at,
    last_verified_at: draft.last_verified_at,
    source_count: sourceCount,
    best_tier: draft.best_tier,
    confidence_score: score,
    confidence_label: confidenceLabel(score, draft.best_tier),
    contradiction_note: draft.contradiction_note ?? null,
  } satisfies CanonicalEvent);
}

export interface SourceRecordDraft {
  source_record_id: string;
  event_id: string | null;
  provider: string;
  provider_record_id: string | null;
  provider_tier: SourceTier;
  source_url: string | null;
  published_at: string;
  retrieved_at: string;
  raw_payload?: unknown;
  /** Serialized upstream payload used for the content hash. */
  hash_input: string;
}

export function makeSourceRecord(draft: SourceRecordDraft): SourceRecord {
  const { hash_input, ...rest } = draft;
  return {
    ...rest,
    content_hash: hashContent(hash_input),
  };
}

/** JSON.stringify that never throws on cyclic/odd payloads. */
export function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "TimeoutError" || err.name === "AbortError"
      ? `request timed out: ${err.message}`
      : err.message;
  }
  return String(err);
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** GET JSON with a hard timeout. Throws on network error or non-2xx. */
export async function fetchJson(
  url: string,
  options: FetchJsonOptions = {},
): Promise<unknown> {
  const { headers = {}, timeoutMs = 10_000 } = options;
  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  return (await response.json()) as unknown;
}
