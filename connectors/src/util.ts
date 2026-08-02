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

/**
 * Epoch values whose magnitude is below this are seconds, at or above are
 * milliseconds. 1e11 ms is 1973-03-03 and 1e11 s is year 5138 — no real feed
 * timestamp is ambiguous across that boundary.
 */
const EPOCH_MS_THRESHOLD = 1e11;

/** Epoch number (seconds or milliseconds) → ISO string, or null when unusable. */
function epochToIso(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const ms = Math.abs(value) < EPOCH_MS_THRESHOLD ? value * 1000 : value;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO string, or null when the input is not a usable timestamp. */
export function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "number") {
    // ArcGIS / USGS emit epoch milliseconds; some layers emit epoch seconds.
    return epochToIso(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    // Numeric strings are epoch stamps (seconds or milliseconds).
    if (/^\d{10,}$/.test(trimmed)) {
      return epochToIso(Number(trimmed));
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

/**
 * Hard ceiling on an upstream response body. Every feed we read is a few MB at
 * most; anything larger is a misconfigured layer or a hostile endpoint, and we
 * refuse it before it reaches JSON.parse.
 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Read a response body as text while counting bytes, aborting past the cap.
 * The cap is enforced on raw bytes so an oversized body is never fully
 * buffered, let alone parsed.
 */
async function readBoundedText(response: Response, url: string): Promise<string> {
  const body = response.body;
  if (!body) {
    // No stream available (empty body, or a runtime that does not expose one).
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error(
        `response body exceeds ${MAX_RESPONSE_BYTES} bytes for ${url}`,
      );
    }
    return text;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(
          `response body exceeds ${MAX_RESPONSE_BYTES} bytes for ${url}`,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return chunks.join("");
}

/**
 * GET JSON with a hard timeout, a redirect refusal (an upstream redirect can
 * move the read to an unvetted host, so it is an error rather than a follow)
 * and a bounded body.
 * Throws on network error, redirect, non-2xx, oversized body or invalid JSON.
 */
export async function fetchJson(
  url: string,
  options: FetchJsonOptions = {},
): Promise<unknown> {
  const { headers = {}, timeoutMs = 10_000 } = options;
  const response = await fetch(url, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }

  // Cheap pre-check: reject an advertised oversize body without reading it.
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BYTES) {
      throw new Error(
        `response too large: Content-Length ${declaredBytes} exceeds ${MAX_RESPONSE_BYTES} bytes for ${url}`,
      );
    }
  }

  const text = await readBoundedText(response, url);
  return JSON.parse(text) as unknown;
}
