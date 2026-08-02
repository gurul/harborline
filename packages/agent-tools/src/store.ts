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
    const contradictionNote = event.contradiction_note ?? existing?.contradiction_note ?? null;

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
    };

    this.events.set(next.event_id, next);
    for (const listener of this.listeners) listener(next);
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
}
