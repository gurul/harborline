/**
 * The tool layer.
 *
 * Every tool is a pure function over an `EventStore` — no network, no clock of
 * its own (the caller supplies `now`), no fabrication. Inputs are validated
 * with Zod at the boundary; outputs are plain JSON carrying provenance and
 * freshness alongside every value.
 */
import { z } from "zod";
import {
  type AccessNeed,
  type AssistantSource,
  type CanonicalEvent,
  type EventType,
  type NearbyObservation,
  type ObservationKind,
  type LonLat,
  type NearbyResource,
  type OperationalStatus,
  type Resource,
  type ResourceType,
  type RouteCandidate,
  type RouteRecommendation,
  type SourceRecord,
  type SourceTier,
  EventTypeSchema,
  OperationalStatusSchema,
  ResourceTypeSchema,
  ageSeconds,
  eventMaxAge,
  formatAge,
  haversineMeters,
  isStale,
  observationMaxAge,
  pointInGeometry,
  resourceMaxAge,
} from "@harborline/event-schema";
import { distanceToGeometryMeters, eventDistanceMeters, type EventStore } from "./store.js";
import {
  HAZARD_BUFFER_M,
  POINT_HAZARD_RADIUS_M,
  buildRecommendation,
  calculateRoutes,
} from "./router.js";
import { planQuery, rankResources, resourceTypeFor, type QueryIntent } from "./planner.js";
import type { EvidenceBundle, RejectedResource } from "./composer.js";

export interface ToolContext {
  store: EventStore;
  now: Date;
}

/**
 * Event types that can physically block or endanger travel.
 *
 * One list, shared by the evidence planner, the deterministic composer and the
 * API service, so "what counts as a hazard" cannot drift between the layer that
 * retrieves records and the layer that describes them.
 */
export const HAZARD_EVENT_TYPES: EventType[] = [
  "road_closure",
  "flood",
  "evacuation_order",
  "landslide",
  "fire",
  "fire_perimeter",
  "fire_detection",
];

/** Fire record types: official ones first, then satellite detections. */
export const FIRE_EVENT_TYPES: EventType[] = ["fire", "fire_perimeter", "fire_detection"];

/** A satellite detection this close to a shelter is named as a caution. */
export const DETECTION_CAUTION_RADIUS_M = 2_000;

/**
 * Events beyond this distance from both route endpoints cannot touch the
 * demonstration graph, which spans a few kilometres. Bounding the query keeps
 * route cost independent of how many statewide records the store holds.
 */
export const ROUTE_EVENT_MARGIN_M = 10_000;

/** Default search radius for resource lookups, in meters. */
export const DEFAULT_RESOURCE_RADIUS_M = 8_000;
/** Upper bound on a caller-supplied radius — a whole-planet query is not a query. */
export const MAX_RESOURCE_RADIUS_M = 50_000;
/** Window used by every assistant entry point for recent updates. */
export const RECENT_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const LatLonSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

export const GetActiveEventsInput = LatLonSchema.extend({
  radius_m: z.number().positive().optional(),
  types: z.array(EventTypeSchema).optional(),
});

export const GetEventDetailsInput = z.object({ event_id: z.string().min(1) });

export const GetNearbyResourcesInput = LatLonSchema.extend({
  resource_type: ResourceTypeSchema.optional(),
  status: OperationalStatusSchema.optional(),
  /**
   * Without a bound the store returns every resource it holds, sorted by
   * distance — a "nearby" list whose tail can be in another county.
   */
  radius_m: z
    .number()
    .positive()
    .max(MAX_RESOURCE_RADIUS_M)
    .default(DEFAULT_RESOURCE_RADIUS_M),
});

export const GetResourceStatusInput = z.object({ resource_id: z.string().min(1) });

export const CalculateRoutesInput = z.object({
  from_lat: z.number().min(-90).max(90),
  from_lon: z.number().min(-180).max(180),
  to_resource_id: z.string().min(1),
});

export const ScoreRouteRiskInput = z.object({
  route_id: z.string().min(1),
  candidates: z.array(z.unknown()),
});

export const GetOfficialInstructionsInput = z.object({ event_id: z.string().min(1) });

export const CompareSourceRecordsInput = z.object({ event_id: z.string().min(1) });

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

export interface ProvenanceEntry {
  provider: string;
  provider_tier: SourceTier;
  source_url: string | null;
  published_at: string;
  retrieved_at: string;
  age_label: string;
}

export type EnrichedEvent = CanonicalEvent & {
  distance_m: number | null;
  age_seconds: number;
  age_label: string;
  max_age_seconds: number;
  stale: boolean;
  providers: string[];
};

export interface GetActiveEventsResult {
  generated_at: string;
  count: number;
  events: EnrichedEvent[];
}

export interface GetEventDetailsResult {
  event: EnrichedEvent;
  source_records: ProvenanceEntry[];
}

export interface ResourceCaution {
  resource_id: string;
  event_id: string;
  event_type: EventType;
  distance_m: number;
  age_label: string;
  note: string;
}

export interface NearbyResourcesResult {
  recommendable: NearbyResource[];
  rejected: {
    resource: NearbyResource;
    rejected_reason: "stale_status" | "full" | "closed" | "inside_hazard_zone";
  }[];
  /**
   * Unconfirmed hazards near a recommendable resource. A moderate satellite
   * detection does not reject a shelter, but the answer must name it.
   */
  cautions: ResourceCaution[];
}

export interface ResourceStatusResult {
  resource: Resource;
  provider: string;
  provider_tier: SourceTier;
  source_url: string | null;
  last_verified_at: string;
  age_seconds: number;
  age_label: string;
  max_age_seconds: number;
  stale: boolean;
}

export interface CalculateRoutesResult {
  candidates: RouteCandidate[];
  recommendation: RouteRecommendation | null;
  destination: Resource;
  routing: "demonstration";
  generated_at: string;
  destination_rejected_reason?: NearbyResourcesResult["rejected"][number]["rejected_reason"];
}

export interface RouteRiskBreakdown {
  route_id: string;
  risk_score: number;
  duration_min: number;
  hazard_exposure_m: number;
  intersecting_event_ids: string[];
  eliminated: boolean;
  rejected_reason: RouteCandidate["rejected_reason"];
  breakdown: {
    travel_minutes: number;
    hazard_penalty: number;
    /** Fixed penalty for crossed satellite detections (never eliminating). */
    detection_penalty: number;
    stale_data_penalty: number;
  };
}

export interface OfficialInstructionsResult {
  event_id: string;
  headline: string;
  instructions: string | null;
  severity: CanonicalEvent["severity"];
  urgency: CanonicalEvent["urgency"];
  certainty: CanonicalEvent["certainty"];
  best_tier: SourceTier;
  providers: string[];
  last_verified_at: string;
  age_label: string;
  stale: boolean;
}

export interface CompareSourceRecordsResult {
  event_id: string;
  headline: string;
  records: ProvenanceEntry[];
  providers: string[];
  tiers: SourceTier[];
  disagreement: boolean;
  contradiction_note: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function provenance(record: SourceRecord, now: Date): ProvenanceEntry {
  return {
    provider: record.provider,
    provider_tier: record.provider_tier,
    source_url: record.source_url,
    published_at: record.published_at,
    retrieved_at: record.retrieved_at,
    age_label: formatAge(record.published_at, now),
  };
}

function enrichEvent(
  event: CanonicalEvent,
  records: SourceRecord[],
  now: Date,
  distance: number | null,
): EnrichedEvent {
  const maxAge = eventMaxAge(event.event_type);
  return {
    ...event,
    distance_m: distance,
    age_seconds: ageSeconds(event.last_verified_at, now),
    age_label: formatAge(event.last_verified_at, now),
    max_age_seconds: maxAge,
    stale: isStale(event.last_verified_at, maxAge, now),
    providers: [...new Set(records.map((r) => r.provider))],
  };
}

/**
 * Classify a resource for recommendation.
 *
 * Freshness is checked before status: a shelter reported open a day ago is not
 * evidence that it is open now. `unknown` is rejected as "closed" because the
 * record does not confirm it is open — the rejection vocabulary is fixed by the
 * REST contract, and "not confirmed open" is the honest reading of it.
 */
function classifyResource(
  resource: Resource,
  now: Date,
): "stale_status" | "full" | "closed" | null {
  if (isStale(resource.last_verified_at, resourceMaxAge(resource.resource_type), now)) {
    return "stale_status";
  }
  switch (resource.operational_status) {
    case "open":
      return null;
    case "full":
      return "full";
    case "closed":
    case "unknown":
      return "closed";
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function get_active_events(
  ctx: ToolContext,
  input: { lat: number; lon: number; radius_m?: number; types?: EventType[] },
): GetActiveEventsResult {
  const args = GetActiveEventsInput.parse(input);
  const center: LonLat = [args.lon, args.lat];
  const events = ctx.store.queryEvents({
    center,
    radius_m: args.radius_m,
    types: args.types,
    statuses: ["active"],
    now: ctx.now,
  });

  return {
    generated_at: ctx.now.toISOString(),
    count: events.length,
    events: events.map((event) => {
      const detail = ctx.store.getEvent(event.event_id);
      return enrichEvent(event, detail?.source_records ?? [], ctx.now, null);
    }),
  };
}

function get_event_details(
  ctx: ToolContext,
  input: { event_id: string },
): GetEventDetailsResult | null {
  const args = GetEventDetailsInput.parse(input);
  const found = ctx.store.getEvent(args.event_id);
  if (!found) return null;
  return {
    event: enrichEvent(found.event, found.source_records, ctx.now, null),
    source_records: found.source_records.map((r) => provenance(r, ctx.now)),
  };
}

/**
 * Camp Fire lesson (Feather River Hospital, 2018-11-08): a facility inside an
 * active hazard footprint is not a destination, whatever its own status record
 * says — the hospital's roster still read "open" while its staff were carrying
 * patients out through the fire. A resource sitting inside the geometry of an
 * active evacuation order, or of an active severe-or-extreme blocking hazard,
 * is therefore rejected outright, with the same severity-scaled point
 * standoffs the router uses.
 *
 * Fail closed on age: a hazard record past its freshness budget has not been
 * re-confirmed, but it has not been withdrawn either. Ignoring it would use the
 * missing update as evidence that the area is now clear.
 */
function containingHazard(
  resource: Resource,
  hazards: CanonicalEvent[],
): CanonicalEvent | null {
  const at = resource.location.coordinates as LonLat;
  for (const event of hazards) {
    if (!HAZARD_EVENT_TYPES.includes(event.event_type)) continue;
    if (
      event.event_type !== "evacuation_order" &&
      event.severity !== "severe" &&
      event.severity !== "extreme"
    ) {
      continue;
    }
    const buffer =
      event.geometry.type === "Point"
        ? POINT_HAZARD_RADIUS_M[event.severity]
        : HAZARD_BUFFER_M;
    if (pointInGeometry(at, event.geometry, buffer)) return event;
  }
  return null;
}

function detectionCautions(
  resource: Resource,
  hazards: CanonicalEvent[],
  now: Date,
): ResourceCaution[] {
  const at = resource.location.coordinates as LonLat;
  const out: ResourceCaution[] = [];
  for (const event of hazards) {
    if (event.event_type !== "fire_detection") continue;
    const distance = distanceToGeometryMeters(at, event.geometry);
    if (distance > DETECTION_CAUTION_RADIUS_M) continue;
    const age = formatAge(event.last_verified_at, now);
    const where = distance === 0 ? "at this location" : `${Math.round(distance)} m away`;
    out.push({
      resource_id: resource.resource_id,
      event_id: event.event_id,
      event_type: event.event_type,
      distance_m: distance,
      age_label: age,
      note: `satellite heat detection ${where}, detected ${age}, unconfirmed by a fire agency`,
    });
  }
  return out;
}

function get_nearby_resources(
  ctx: ToolContext,
  input: {
    lat: number;
    lon: number;
    resource_type?: ResourceType;
    status?: OperationalStatus;
    radius_m?: number;
  },
): NearbyResourcesResult {
  const args = GetNearbyResourcesInput.parse(input);
  const nearby = ctx.store.queryResources({
    center: [args.lon, args.lat],
    type: args.resource_type,
    status: args.status,
    radius_m: args.radius_m,
  });

  const hazards = ctx.store.queryEvents({
    center: [args.lon, args.lat],
    radius_m: MAX_RESOURCE_RADIUS_M,
    types: HAZARD_EVENT_TYPES,
    statuses: ["active"],
    now: ctx.now,
  });

  const recommendable: NearbyResource[] = [];
  const rejected: NearbyResourcesResult["rejected"] = [];
  const cautions: ResourceCaution[] = [];

  for (const resource of nearby) {
    // Freshness and status first (the existing gate), then hazard containment
    // as the final check on anything still recommendable: a fresh, open
    // facility inside an active severe hazard footprint is Feather River
    // Hospital — its own record says "open" and it must still be rejected.
    const reason = classifyResource(resource, ctx.now);
    if (reason !== null) {
      rejected.push({ resource, rejected_reason: reason });
    } else if (containingHazard(resource, hazards)) {
      rejected.push({ resource, rejected_reason: "inside_hazard_zone" });
    } else {
      recommendable.push(resource);
      cautions.push(...detectionCautions(resource, hazards, ctx.now));
    }
  }

  return { recommendable, rejected, cautions };
}

function get_resource_status(
  ctx: ToolContext,
  input: { resource_id: string },
): ResourceStatusResult | null {
  const args = GetResourceStatusInput.parse(input);
  const resource = ctx.store.getResource(args.resource_id);
  if (!resource) return null;
  const maxAge = resourceMaxAge(resource.resource_type);
  return {
    resource,
    provider: resource.provider,
    provider_tier: resource.provider_tier,
    source_url: resource.source_url,
    last_verified_at: resource.last_verified_at,
    age_seconds: ageSeconds(resource.last_verified_at, ctx.now),
    age_label: formatAge(resource.last_verified_at, ctx.now),
    max_age_seconds: maxAge,
    stale: isStale(resource.last_verified_at, maxAge, ctx.now),
  };
}

function calculate_routes(
  ctx: ToolContext,
  input: { from_lat: number; from_lon: number; to_resource_id: string },
): CalculateRoutesResult {
  const args = CalculateRoutesInput.parse(input);
  const destination = ctx.store.getResource(args.to_resource_id);
  if (!destination) {
    throw new Error(`calculate_routes: unknown resource ${args.to_resource_id}`);
  }

  const from: LonLat = [args.from_lon, args.from_lat];
  const to = destination.location.coordinates as LonLat;
  const events = ctx.store.queryEvents({
    center: from,
    radius_m: haversineMeters(from, to) + ROUTE_EVENT_MARGIN_M,
    statuses: ["active"],
    now: ctx.now,
  });
  const rejection = classifyResource(destination, ctx.now) ??
    (containingHazard(destination, events) ? "inside_hazard_zone" : null);
  if (rejection) {
    return {
      candidates: [],
      recommendation: null,
      destination,
      destination_rejected_reason: rejection,
      routing: "demonstration",
      generated_at: ctx.now.toISOString(),
    };
  }
  const { candidates, best } = calculateRoutes({ from, to, events, now: ctx.now });

  // Evidence = every hazard the router weighed, not just the ones on the
  // chosen line — "avoids N hazards" has to be countable.
  const evidenceEventIds = [
    ...new Set(candidates.flatMap((c) => c.intersecting_event_ids)),
  ];

  return {
    candidates,
    recommendation: best
      ? buildRecommendation(best, destination, evidenceEventIds, ctx.now, events)
      : null,
    destination,
    routing: "demonstration",
    generated_at: ctx.now.toISOString(),
  };
}

function score_route_risk(
  _ctx: ToolContext,
  input: { route_id: string; candidates: RouteCandidate[] },
): RouteRiskBreakdown | null {
  ScoreRouteRiskInput.parse(input);
  const candidate = input.candidates.find((c) => c.route_id === input.route_id);
  if (!candidate) return null;

  const hazardPenalty = candidate.hazard_exposure_m / 100;
  const detectionPenalty = candidate.penalty_min ?? 0;
  const stalePenalty = Math.max(
    0,
    candidate.risk_score - candidate.duration_min - hazardPenalty - detectionPenalty,
  );

  return {
    route_id: candidate.route_id,
    risk_score: candidate.risk_score,
    duration_min: candidate.duration_min,
    hazard_exposure_m: candidate.hazard_exposure_m,
    intersecting_event_ids: candidate.intersecting_event_ids,
    eliminated: candidate.eliminated,
    rejected_reason: candidate.rejected_reason,
    breakdown: {
      travel_minutes: candidate.duration_min,
      hazard_penalty: hazardPenalty,
      detection_penalty: detectionPenalty,
      stale_data_penalty: stalePenalty,
    },
  };
}

function get_official_instructions(
  ctx: ToolContext,
  input: { event_id: string },
): OfficialInstructionsResult | null {
  const args = GetOfficialInstructionsInput.parse(input);
  const found = ctx.store.getEvent(args.event_id);
  if (!found) return null;
  const { event, source_records } = found;
  return {
    event_id: event.event_id,
    headline: event.headline,
    instructions: event.instructions,
    severity: event.severity,
    urgency: event.urgency,
    certainty: event.certainty,
    best_tier: event.best_tier,
    providers: [...new Set(source_records.map((r) => r.provider))],
    last_verified_at: event.last_verified_at,
    age_label: formatAge(event.last_verified_at, ctx.now),
    stale: isStale(event.last_verified_at, eventMaxAge(event.event_type), ctx.now),
  };
}

function compare_source_records(
  ctx: ToolContext,
  input: { event_id: string },
): CompareSourceRecordsResult | null {
  const args = CompareSourceRecordsInput.parse(input);
  const found = ctx.store.getEvent(args.event_id);
  if (!found) return null;

  const records = [...found.source_records].sort(
    (a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime(),
  );
  const tiers = [...new Set(records.map((r) => r.provider_tier))];
  const hasAuthority = tiers.some((t) => t === "A" || t === "B" || t === "C");
  const hasUnverified = tiers.some((t) => t === "D" || t === "E");

  return {
    event_id: found.event.event_id,
    headline: found.event.headline,
    records: records.map((r) => provenance(r, ctx.now)),
    providers: [...new Set(records.map((r) => r.provider))],
    tiers,
    disagreement:
      found.event.contradiction_note !== null || (hasAuthority && hasUnverified),
    contradiction_note: found.event.contradiction_note,
  };
}

// ---------------------------------------------------------------------------
// Environment summary (air quality, river gauge, smoke, fire, power)
// ---------------------------------------------------------------------------

/** Default radius for the environment summary and fire questions, metres. */
export const ENVIRONMENT_RADIUS_M = 25_000;
export const MAX_ENVIRONMENT_RADIUS_M = 200_000;

export const GetEnvironmentSummaryInput = LatLonSchema.extend({
  radius_m: z.number().positive().max(MAX_ENVIRONMENT_RADIUS_M).default(ENVIRONMENT_RADIUS_M),
  /**
   * True when at least one fire connector's latest fetch succeeded. The tool
   * layer has no view of connector health, so the caller supplies it. Without
   * it the fire section reports `no_data`.
   */
  fire_feeds_healthy: z.boolean().default(false),
});

export type ObservationStatus = "ok" | "stale" | "no_data";

interface Provenanced {
  provider?: string;
  provider_tier?: SourceTier;
  source_url?: string | null;
  last_verified_at?: string;
  age_label?: string;
}

export interface AirQualitySection extends Provenanced {
  status: ObservationStatus;
  aqi?: number;
  category?: string;
  pollutant?: string;
  name?: string;
  distance_m?: number;
}

export interface StreamGaugeSection extends Provenanced {
  status: ObservationStatus;
  name?: string;
  site_id?: string;
  stage_ft?: number;
  flood_category?: "no_flooding" | "action" | "minor" | "moderate" | "major" | "unknown";
  forecast_category?: string;
  distance_m?: number;
}

/** Internal: the assistant reads it; the REST contract does not carry it. */
export interface SmokeSection extends Provenanced {
  status: ObservationStatus;
  density?: string;
  over_point?: boolean;
  name?: string;
  distance_m?: number;
}

export interface FireSection {
  status: "ok" | "no_data";
  /** Satellite detection clusters (events), not individual pixels. */
  detections: number;
  nearest_distance_m?: number;
  newest_observed_at?: string;
  newest_age_label?: string;
  perimeters: number;
  nearest_perimeter_name?: string;
  /** A fire agency record (perimeter, incident or fire alert) is within the radius. */
  confirmed: boolean;
  note: string;
}

export interface PowerSection {
  status: "not_monitored" | "outage_reported";
  note: string;
}

export interface EnvironmentSummary {
  generated_at: string;
  radius_m: number;
  air_quality: AirQualitySection;
  stream_gauge: StreamGaugeSection;
  smoke: SmokeSection;
  fire: FireSection;
  power: PowerSection;
  sources: AssistantSource[];
}

/** The note the fire section carries when the feed is healthy and nothing is near. */
export const FIRE_NOT_PROOF_NOTE =
  "No satellite detection is not proof of no fire: satellites pass only a few times a day, " +
  "and cloud or smoke can hide a fire.";

function kmLabel(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/**
 * Nearest fresh observation of a kind; when none is fresh, the nearest stale
 * one, reported as stale so it is never described as current.
 */
function pickObservation(
  ctx: ToolContext,
  center: LonLat,
  radius: number,
  kind: ObservationKind,
): { obs: NearbyObservation; stale: boolean } | null {
  const found = ctx.store.queryObservations?.({ center, radius_m: radius, kind }) ?? [];
  if (found.length === 0) return null;
  const maxAge = observationMaxAge(kind);
  const fresh = found.find((o) => !isStale(o.last_verified_at, maxAge, ctx.now));
  if (fresh) return { obs: fresh, stale: false };
  return { obs: found[0]!, stale: true };
}

function provenanceOf(obs: NearbyObservation, now: Date): Provenanced & { distance_m: number } {
  return {
    provider: obs.provider,
    provider_tier: obs.provider_tier,
    source_url: obs.source_url,
    last_verified_at: obs.last_verified_at,
    age_label: formatAge(obs.last_verified_at, now),
    distance_m: Math.round(obs.distance_m),
  };
}

function get_environment_summary(
  ctx: ToolContext,
  input: { lat: number; lon: number; radius_m?: number; fire_feeds_healthy?: boolean },
): EnvironmentSummary {
  const args = GetEnvironmentSummaryInput.parse(input);
  const center: LonLat = [args.lon, args.lat];
  const radius = args.radius_m;
  const sources: AssistantSource[] = [];
  const cite = (provider: string, tier: SourceTier, url: string | null, at: string) => {
    const existing = sources.find((s) => s.provider === provider && s.url === url && s.tier === tier);
    if (!existing) sources.push({ provider, tier, url, last_verified_at: at });
    else if (new Date(at).getTime() > new Date(existing.last_verified_at).getTime()) {
      existing.last_verified_at = at;
    }
  };

  // Air quality.
  let air_quality: AirQualitySection = { status: "no_data" };
  const air = pickObservation(ctx, center, radius, "air_quality");
  if (air && air.obs.kind === "air_quality") {
    air_quality = {
      status: air.stale ? "stale" : "ok",
      aqi: air.obs.aqi,
      category: air.obs.category,
      pollutant: air.obs.pollutant,
      name: air.obs.name,
      ...provenanceOf(air.obs, ctx.now),
    };
    cite(air.obs.provider, air.obs.provider_tier, air.obs.source_url, air.obs.last_verified_at);
  }

  // River gauge.
  let stream_gauge: StreamGaugeSection = { status: "no_data" };
  const gauge = pickObservation(ctx, center, radius, "stream_gauge");
  if (gauge && gauge.obs.kind === "stream_gauge") {
    stream_gauge = {
      status: gauge.stale ? "stale" : "ok",
      name: gauge.obs.name,
      site_id: gauge.obs.site_id,
      ...(gauge.obs.stage_ft !== null ? { stage_ft: gauge.obs.stage_ft } : {}),
      flood_category: gauge.obs.flood_category,
      ...(gauge.obs.forecast_category ? { forecast_category: gauge.obs.forecast_category } : {}),
      ...provenanceOf(gauge.obs, ctx.now),
    };
    cite(gauge.obs.provider, gauge.obs.provider_tier, gauge.obs.source_url, gauge.obs.last_verified_at);
  }

  // Smoke (internal section).
  let smoke: SmokeSection = { status: "no_data" };
  const plume = pickObservation(ctx, center, radius, "smoke");
  if (plume && plume.obs.kind === "smoke") {
    smoke = {
      status: plume.stale ? "stale" : "ok",
      density: plume.obs.density,
      over_point: plume.obs.distance_m === 0,
      name: plume.obs.name,
      ...provenanceOf(plume.obs, ctx.now),
    };
    cite(plume.obs.provider, plume.obs.provider_tier, plume.obs.source_url, plume.obs.last_verified_at);
  }

  // Fire.
  const fireEvents = ctx.store.queryEvents({
    center,
    radius_m: radius,
    types: FIRE_EVENT_TYPES,
    statuses: ["active"],
    now: ctx.now,
  });
  const detections = fireEvents.filter((e) => e.event_type === "fire_detection");
  const perimeters = fireEvents.filter((e) => e.event_type === "fire_perimeter");
  const official = fireEvents.filter((e) => e.event_type !== "fire_detection");
  const nearest = (events: CanonicalEvent[]) =>
    events
      .map((e) => ({ e, d: eventDistanceMeters(center, e) }))
      .sort((a, b) => a.d - b.d)[0];
  const nearestDetection = nearest(detections);
  const nearestPerimeter = nearest(perimeters);
  const newestDetection = detections.reduce<CanonicalEvent | null>(
    (best, e) =>
      best === null || new Date(e.last_verified_at).getTime() > new Date(best.last_verified_at).getTime()
        ? e
        : best,
    null,
  );
  for (const event of fireEvents) {
    const records = ctx.store.getEvent(event.event_id)?.source_records ?? [];
    for (const r of records) cite(r.provider, r.provider_tier, r.source_url, r.published_at);
  }

  let note: string;
  if (!args.fire_feeds_healthy) {
    note =
      "None of the fire feeds has a current successful fetch, so fire status here is unknown. " +
      "A missing record is not evidence about fire either way.";
  } else if (fireEvents.length === 0) {
    note = `No satellite heat detection or fire agency record within ${kmLabel(radius)} in the last 24 h. ${FIRE_NOT_PROOF_NOTE}`;
  } else {
    const parts: string[] = [];
    if (official.length > 0) {
      parts.push(`${official.length} fire agency record${official.length === 1 ? "" : "s"} within ${kmLabel(radius)}.`);
    }
    if (detections.length > 0 && nearestDetection && newestDetection) {
      parts.push(
        `${detections.length} satellite heat detection cluster${detections.length === 1 ? "" : "s"} ` +
          `within ${kmLabel(radius)}, nearest ${kmLabel(nearestDetection.d)}, newest detected ` +
          `${formatAge(newestDetection.last_verified_at, ctx.now)}, unconfirmed by a fire agency.`,
      );
    }
    parts.push("Satellites pass only a few times a day; cloud or smoke can hide a fire.");
    note = parts.join(" ");
  }

  const fire: FireSection = {
    status: args.fire_feeds_healthy ? "ok" : "no_data",
    detections: detections.length,
    ...(nearestDetection ? { nearest_distance_m: Math.round(nearestDetection.d) } : {}),
    ...(newestDetection
      ? {
          newest_observed_at: newestDetection.last_verified_at,
          newest_age_label: formatAge(newestDetection.last_verified_at, ctx.now),
        }
      : {}),
    perimeters: perimeters.length,
    ...(nearestPerimeter ? { nearest_perimeter_name: nearestPerimeter.e.headline } : {}),
    confirmed: official.length > 0,
    note,
  };

  // Power. No outage source is configured, so the absence of a record is never
  // reported as "no outage": the section says the area is not monitored.
  const outages = ctx.store.queryEvents({
    center,
    radius_m: radius,
    types: ["power_outage"],
    statuses: ["active"],
    now: ctx.now,
  });
  let power: PowerSection;
  if (outages.length > 0) {
    const newest = outages[0]!;
    const records = ctx.store.getEvent(newest.event_id)?.source_records ?? [];
    for (const r of records) cite(r.provider, r.provider_tier, r.source_url, r.published_at);
    power = {
      status: "outage_reported",
      note:
        `${outages.length} power outage report${outages.length === 1 ? "" : "s"} within ${kmLabel(radius)}, ` +
        `newest updated ${formatAge(newest.last_verified_at, ctx.now)}. Outage coverage is partial.`,
    };
  } else {
    power = {
      status: "not_monitored",
      note:
        "Power outages are not monitored for this area. The absence of a report does not mean the power is on.",
    };
  }

  return {
    generated_at: ctx.now.toISOString(),
    radius_m: radius,
    air_quality,
    stream_gauge,
    smoke,
    fire,
    power,
    sources,
  };
}

export const tools = {
  get_environment_summary,
  get_active_events,
  get_event_details,
  get_nearby_resources,
  get_resource_status,
  calculate_routes,
  score_route_risk,
  get_official_instructions,
  compare_source_records,
};

export type ToolRegistry = typeof tools;

// ---------------------------------------------------------------------------
// Evidence assembly
// ---------------------------------------------------------------------------

/**
 * Run the tools the planner selects and package the results as an
 * `EvidenceBundle`. Keeps the API handler thin and guarantees the bundle always
 * carries the source records behind every event it contains.
 */
export interface GatherOptions {
  radius_m?: number;
  /** Caller-stated access needs; applied by ranking only. */
  access_needs?: AccessNeed[];
  /** A shelter the caller asked to be routed to. Forces the shelter path. */
  destination_resource_id?: string;
  /** Whether a fire connector's latest fetch succeeded (see get_environment_summary). */
  fire_feeds_healthy?: boolean;
}

/** Official record types a fire question reports alongside the fire feeds. */
const FIRE_QUESTION_TYPES: EventType[] = [...FIRE_EVENT_TYPES, "evacuation_order", "weather_warning"];
/** Records an air question reports: alerts, and any evacuation order nearby. */
const AIR_QUESTION_TYPES: EventType[] = ["weather_warning", "evacuation_order"];

export function gatherEvidence(
  ctx: ToolContext,
  question: string,
  at: LonLat,
  opts: GatherOptions = {},
): EvidenceBundle {
  // A request for a route to a named shelter is a shelter request, whatever
  // the wording. The bundle records the intent so the composer agrees.
  const intent: QueryIntent = opts.destination_resource_id
    ? "nearest_shelter"
    : planQuery(question).intent;
  const [lon, lat] = at;
  const environmental = intent === "fire_nearby" || intent === "air_quality";
  const radius = opts.radius_m ?? (environmental ? ENVIRONMENT_RADIUS_M : DEFAULT_RESOURCE_RADIUS_M);

  const typeFilter: EventType[] | undefined =
    intent === "roads_to_avoid"
      ? HAZARD_EVENT_TYPES
      : intent === "fire_nearby"
        ? FIRE_QUESTION_TYPES
        : intent === "air_quality"
          ? AIR_QUESTION_TYPES
          : undefined;

  const events = tools.get_active_events(ctx, {
    lat,
    lon,
    radius_m: radius,
    types: typeFilter,
  }).events.filter((event) => intent !== "what_changed" ||
    new Date(event.last_verified_at).getTime() >= ctx.now.getTime() - RECENT_WINDOW_MS);

  const sourceRecords: SourceRecord[] = [];
  for (const event of events) {
    const detail = ctx.store.getEvent(event.event_id);
    if (detail) sourceRecords.push(...detail.source_records);
  }

  const bundle: EvidenceBundle = { intent, events, source_records: sourceRecords };

  if (environmental) {
    bundle.environment = tools.get_environment_summary(ctx, {
      lat,
      lon,
      radius_m: Math.min(radius, MAX_ENVIRONMENT_RADIUS_M),
      fire_feeds_healthy: opts.fire_feeds_healthy ?? false,
    });
  }

  if (intent === "nearest_shelter" || intent === "resource_query") {
    const resourceType: ResourceType | undefined =
      intent === "nearest_shelter" ? "shelter" : resourceTypeFor(question);
    const { recommendable, rejected, cautions } = tools.get_nearby_resources(ctx, {
      lat,
      lon,
      resource_type: resourceType,
      radius_m: radius,
    });
    const requested = intent === "nearest_shelter" && opts.destination_resource_id
      ? placeRequested(ctx, opts.destination_resource_id, at, recommendable, rejected)
      : undefined;
    const needs = opts.access_needs ?? [];
    bundle.ranking = {
      access_needs: needs,
      ...(requested ? { requested_resource_id: opts.destination_resource_id, requested_status: requested } : {}),
    };
    bundle.resources = rankResources(question, recommendable, {
      access_needs: needs,
      preferred_resource_id: requested === "selected" ? opts.destination_resource_id : undefined,
    });
    bundle.rejected_resources = rejected as RejectedResource[];
    bundle.resource_cautions = cautions;

    if (intent === "nearest_shelter" && recommendable.length > 0) {
      const destination = bundle.resources![0]!;
      const route = tools.calculate_routes(ctx, {
        from_lat: lat,
        from_lon: lon,
        to_resource_id: destination.resource_id,
      });
      bundle.route = {
        candidates: route.candidates,
        recommendation: route.recommendation,
        destination: route.destination,
      };
    }
  }

  return bundle;
}

/**
 * Put a caller-requested shelter into the right list. A shelter outside the
 * search radius is looked up by id and passes the same gate as the others.
 * Mutates `recommendable` / `rejected`. Returns how the request was resolved.
 */
function placeRequested(
  ctx: ToolContext,
  id: string,
  at: LonLat,
  recommendable: NearbyResource[],
  rejected: NearbyResourcesResult["rejected"],
): "selected" | "not_recommendable" | "unknown" {
  if (recommendable.some((r) => r.resource_id === id)) return "selected";
  if (rejected.some((r) => r.resource.resource_id === id)) return "not_recommendable";
  const resource = ctx.store.getResource(id);
  if (!resource || resource.resource_type !== "shelter") return "unknown";
  const nearby: NearbyResource = {
    ...resource,
    distance_m: haversineMeters(at, resource.location.coordinates as LonLat),
  };
  const hazards = ctx.store.queryEvents({
    center: resource.location.coordinates as LonLat,
    radius_m: MAX_RESOURCE_RADIUS_M,
    types: HAZARD_EVENT_TYPES,
    statuses: ["active"],
    now: ctx.now,
  });
  const reason = classifyResource(resource, ctx.now) ??
    (containingHazard(resource, hazards) ? "inside_hazard_zone" : null);
  if (reason) {
    rejected.push({ resource: nearby, rejected_reason: reason });
    return "not_recommendable";
  }
  recommendable.push(nearby);
  return "selected";
}
