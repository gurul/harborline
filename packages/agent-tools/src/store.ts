/**
 * Storage contract for Harborline.
 *
 * The interface is deliberately PostGIS-shaped (geometry in, geometry out) so a
 * `PostgisStore` can drop in later without changing callers. `MemoryStore` is
 * the MVP implementation shared by the API service, the tool layer, and evals.
 *
 * Invariant: structured records determine facts. The store never invents a
 * value — it merges records, unions provenance, and recomputes confidence from
 * the schema's transparent scoring function.
 */
import {
  type CanonicalEvent,
  type EventStatus,
  type EventType,
  type Geometry,
  type LonLat,
  type NearbyResource,
  type OperationalStatus,
  type Resource,
  type ResourceType,
  type SourceRecord,
  type SourceTier,
  SEVERITY_RANK,
  computeConfidence,
  confidenceLabel,
  distanceToLineStringMeters,
  eventMaxAge,
  geometryCentroid,
  haversineMeters,
  pointInGeometry,
} from "@harborline/event-schema";

/** Authority ordering — A is the highest-authority tier. */
const TIER_ORDER: readonly SourceTier[] = ["A", "B", "C", "D", "E"];

export function highestTier(tiers: readonly SourceTier[]): SourceTier | null {
  let best: SourceTier | null = null;
  for (const tier of tiers) {
    if (best === null || TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(best)) {
      best = tier;
    }
  }
  return best;
}

/**
 * Approximate distance from a point to a geometry, in meters.
 * Returns 0 when the point falls inside a polygon.
 */
export function distanceToGeometryMeters(pt: LonLat, geom: Geometry): number {
  switch (geom.type) {
    case "Point":
      return haversineMeters(pt, geom.coordinates as LonLat);
    case "LineString":
      return distanceToLineStringMeters(pt, geom.coordinates as LonLat[]);
    case "Polygon":
    case "MultiPolygon": {
      if (pointInGeometry(pt, geom)) return 0;
      const rings: LonLat[][] =
        geom.type === "Polygon"
          ? (geom.coordinates as LonLat[][])
          : (geom.coordinates.flat() as LonLat[][]);
      let best = Infinity;
      for (const ring of rings) {
        best = Math.min(best, distanceToLineStringMeters(pt, ring));
      }
      return best;
    }
  }
}

/** Distance used for radius filtering: geometry-aware, centroid as a floor. */
export function eventDistanceMeters(pt: LonLat, event: CanonicalEvent): number {
  return Math.min(
    distanceToGeometryMeters(pt, event.geometry),
    haversineMeters(pt, geometryCentroid(event.geometry)),
  );
}

/** Parsed `ends_at`, or null when absent/unparseable. */
function endsAtMs(event: CanonicalEvent): number | null {
  if (!event.ends_at) return null;
  const ms = new Date(event.ends_at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Status to store for an event whose end time may already have passed.
 *
 * Only "active" is transitioned — "cancelled" is a stronger, deliberate
 * statement than "expired" and is never downgraded to it.
 */
function lifecycleStatus(event: CanonicalEvent, referenceMs: number): EventStatus {
  if (event.status !== "active") return event.status;
  const ends = endsAtMs(event);
  return ends !== null && ends < referenceMs ? "expired" : event.status;
}

export interface EventQuery {
  center?: LonLat;
  radius_m?: number;
  types?: EventType[];
  statuses?: EventStatus[];
  now: Date;
}

export interface ResourceQuery {
  center: LonLat;
  radius_m?: number;
  type?: ResourceType;
  status?: OperationalStatus;
}

/**
 * Hard ceiling on retained events. A store that only ever grows is an
 * availability bug waiting for a busy feed day; the sweep evicts the
 * least-recently-verified records once this is exceeded.
 */
export const MAX_EVENTS = 10_000;

/**
 * Multiple of an event type's freshness budget after which the record is not
 * merely stale but worthless, and is deleted outright.
 */
export const RETENTION_AGE_MULTIPLIER = 4;

export interface SweepResult {
  /** Active events transitioned to "expired" because their end time passed. */
  expired: number;
  /** Events removed entirely (past retention, or evicted by the size cap). */
  deleted: number;
}

export interface EventStore {
  upsertEvent(event: CanonicalEvent, sourceRecords: SourceRecord[]): void;
  queryEvents(opts: EventQuery): CanonicalEvent[];
  getEvent(id: string): { event: CanonicalEvent; source_records: SourceRecord[] } | null;
  upsertResource(resource: Resource): void;
  queryResources(opts: ResourceQuery): NearbyResource[];
  getResource(id: string): Resource | null;
  allEvents(): CanonicalEvent[];
  allResources(): Resource[];
  /** Subscribe to upserts. Returns an unsubscribe function. */
  onChange(cb: (event: CanonicalEvent) => void): () => void;
  /**
   * Expire, prune and cap stored events. Optional on the interface so existing
   * implementations stay valid; `MemoryStore` implements it.
   */
  sweepExpired?(now: Date): SweepResult;
}

export class MemoryStore implements EventStore {
  private readonly events = new Map<string, CanonicalEvent>();
  private readonly records = new Map<string, Map<string, SourceRecord>>();
  private readonly resources = new Map<string, Resource>();
  private readonly listeners = new Set<(event: CanonicalEvent) => void>();

  upsertEvent(event: CanonicalEvent, sourceRecords: SourceRecord[]): void {
    const existing = this.events.get(event.event_id);

    // Union of source records, keyed by source_record_id — provenance is never
    // merged away.
    const bucket = this.records.get(event.event_id) ?? new Map<string, SourceRecord>();
    for (const record of sourceRecords) {
      bucket.set(record.source_record_id, record);
    }
    this.records.set(event.event_id, bucket);
    const merged = [...bucket.values()];

    // The newer verification wins for descriptive fields; the older one is kept
    // when the incoming record is stale relative to what we already hold.
    const incomingIsNewer =
      !existing ||
      new Date(event.last_verified_at).getTime() >=
        new Date(existing.last_verified_at).getTime();
    const base = incomingIsNewer ? event : existing;

    const providers = new Set(merged.map((r) => r.provider));
    const sourceCount = Math.max(1, providers.size);
    const bestTier =
      highestTier(merged.map((r) => r.provider_tier)) ?? base.best_tier ?? event.best_tier;

    const referenceTime = this.referenceTime(merged, base.last_verified_at);
    const ageSec = Math.max(
      0,
      (referenceTime - new Date(base.last_verified_at).getTime()) / 1000,
    );

    // A newer authoritative record wins outright: if it carries no contradiction,
    // the dispute it previously recorded has been resolved and the stale note
    // must not survive. An older record can still contribute a note it saw, but
    // it can never erase one.
    const contradictionNote = incomingIsNewer
      ? event.contradiction_note
      : (event.contradiction_note ?? existing?.contradiction_note ?? null);

    const score = computeConfidence({
      tier: bestTier,
      age_seconds: ageSec,
      max_age_seconds: eventMaxAge(base.event_type),
      corroborating_sources: sourceCount,
      // A disputed event is less internally consistent; the note is the signal.
      consistency: contradictionNote ? 0.6 : 1,
    });

    const next: CanonicalEvent = {
      ...base,
      event_id: event.event_id,
      source_count: sourceCount,
      best_tier: bestTier,
      confidence_score: score,
      confidence_label: confidenceLabel(score, bestTier),
      contradiction_note: contradictionNote,
      status: lifecycleStatus(base, referenceTime),
    };

    this.events.set(next.event_id, next);
    this.emit(next);
  }

  /**
   * Notify subscribers. Each listener is isolated: a subscriber that throws
   * must not abort the upsert or starve the listeners registered after it.
   */
  private emit(event: CanonicalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(
          `MemoryStore: onChange listener threw for event ${event.event_id}`,
          error,
        );
      }
    }
  }

  /**
   * Deterministic "now" for confidence decay: the newest retrieval among the
   * event's source records, falling back to wall-clock when no record carries
   * one. Using retrieval time keeps merge results reproducible in tests.
   */
  private referenceTime(records: SourceRecord[], lastVerifiedAt: string): number {
    let best = Number.NEGATIVE_INFINITY;
    for (const record of records) {
      const t = new Date(record.retrieved_at).getTime();
      if (Number.isFinite(t) && t > best) best = t;
    }
    if (!Number.isFinite(best)) best = Date.now();
    return Math.max(best, new Date(lastVerifiedAt).getTime());
  }

  queryEvents(opts: EventQuery): CanonicalEvent[] {
    const statuses = opts.statuses ?? (["active"] as EventStatus[]);
    const radius = opts.radius_m ?? Infinity;

    const matched = [...this.events.values()].filter((event) => {
      // An event whose end time has passed is never returned, even if a sweep
      // has not yet run and its stored status still reads "active". Serving a
      // finished hazard as current is the failure this guards against; callers
      // that want history use allEvents()/getEvent().
      const ends = endsAtMs(event);
      if (ends !== null && ends < opts.now.getTime()) return false;
      if (statuses.length > 0 && !statuses.includes(event.status)) return false;
      if (opts.types && opts.types.length > 0 && !opts.types.includes(event.event_type)) {
        return false;
      }
      if (opts.center && Number.isFinite(radius)) {
        if (eventDistanceMeters(opts.center, event) > radius) return false;
      }
      return true;
    });

    return matched.sort((a, b) => {
      const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (bySeverity !== 0) return bySeverity;
      return (
        new Date(b.last_verified_at).getTime() - new Date(a.last_verified_at).getTime()
      );
    });
  }

  getEvent(id: string): { event: CanonicalEvent; source_records: SourceRecord[] } | null {
    const event = this.events.get(id);
    if (!event) return null;
    return {
      event,
      source_records: [...(this.records.get(id)?.values() ?? [])],
    };
  }

  upsertResource(resource: Resource): void {
    this.resources.set(resource.resource_id, resource);
  }

  queryResources(opts: ResourceQuery): NearbyResource[] {
    const radius = opts.radius_m ?? Infinity;
    const out: NearbyResource[] = [];
    for (const resource of this.resources.values()) {
      if (opts.type && resource.resource_type !== opts.type) continue;
      if (opts.status && resource.operational_status !== opts.status) continue;
      const distance = haversineMeters(opts.center, resource.location.coordinates as LonLat);
      if (distance > radius) continue;
      out.push({ ...resource, distance_m: distance });
    }
    return out.sort((a, b) => a.distance_m - b.distance_m);
  }

  getResource(id: string): Resource | null {
    return this.resources.get(id) ?? null;
  }

  allEvents(): CanonicalEvent[] {
    return [...this.events.values()];
  }

  allResources(): Resource[] {
    return [...this.resources.values()];
  }

  onChange(cb: (event: CanonicalEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Age out the event table. Idempotent; safe to run on a timer.
   *
   * 1. Active events whose `ends_at` has passed become "expired". They stay
   *    queryable by id, so a user who was told about a hazard can still see
   *    what became of it.
   * 2. Events not re-verified for RETENTION_AGE_MULTIPLIER × their freshness
   *    budget are deleted along with their source-record bucket — well past
   *    stale, they are no longer evidence of anything.
   * 3. If the table still exceeds MAX_EVENTS, the least-recently-verified
   *    records are evicted until it fits.
   */
  sweepExpired(now: Date): SweepResult {
    const nowMs = now.getTime();
    let expired = 0;
    let deleted = 0;

    for (const [id, event] of this.events) {
      const next = lifecycleStatus(event, nowMs);
      if (next !== event.status) {
        this.events.set(id, { ...event, status: next });
        expired++;
      }
    }

    for (const [id, event] of [...this.events]) {
      const retentionSeconds = RETENTION_AGE_MULTIPLIER * eventMaxAge(event.event_type);
      const verifiedMs = new Date(event.last_verified_at).getTime();
      if (!Number.isFinite(verifiedMs)) continue;
      // Plain arithmetic rather than ageSeconds(): a future-dated record must
      // read as "not yet old", not as the infinite-age staleness sentinel.
      if ((nowMs - verifiedMs) / 1000 > retentionSeconds) {
        this.deleteEvent(id);
        deleted++;
      }
    }

    if (this.events.size > MAX_EVENTS) {
      const oldestFirst = [...this.events.values()].sort(
        (a, b) =>
          new Date(a.last_verified_at).getTime() - new Date(b.last_verified_at).getTime(),
      );
      const excess = this.events.size - MAX_EVENTS;
      for (let i = 0; i < excess; i++) {
        this.deleteEvent(oldestFirst[i]!.event_id);
        deleted++;
      }
    }

    return { expired, deleted };
  }

  /** Drop an event and the provenance bucket that belongs to it. */
  private deleteEvent(id: string): void {
    this.events.delete(id);
    this.records.delete(id);
  }
}
