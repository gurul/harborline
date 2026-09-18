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
  type CanonicalEvent,
  type EventType,
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
  isStale,
  pointInGeometry,
  resourceMaxAge,
} from "@harborline/event-schema";
import type { EventStore } from "./store.js";
import {
  HAZARD_BUFFER_M,
  POINT_HAZARD_RADIUS_M,
  buildRecommendation,
  calculateRoutes,
} from "./router.js";
import { planQuery, rankResources } from "./planner.js";
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
];

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

export interface NearbyResourcesResult {
  recommendable: NearbyResource[];
  rejected: {
    resource: NearbyResource;
    rejected_reason: "stale_status" | "full" | "closed" | "inside_hazard_zone";
  }[];
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
 * patients out through the fire. A resource sitting inside the geometry of a
 * fresh, active, severe-or-extreme blocking hazard is therefore rejected
 * outright, with the same severity-scaled point standoffs the router uses.
 */
function containingHazard(
  resource: Resource,
  hazards: CanonicalEvent[],
  now: Date,
): CanonicalEvent | null {
  const at = resource.location.coordinates as LonLat;
  for (const event of hazards) {
    if (!HAZARD_EVENT_TYPES.includes(event.event_type)) continue;
    if (event.severity !== "severe" && event.severity !== "extreme") continue;
    if (isStale(event.last_verified_at, eventMaxAge(event.event_type), now)) continue;
    const buffer =
      event.geometry.type === "Point"
        ? POINT_HAZARD_RADIUS_M[event.severity]
        : HAZARD_BUFFER_M;
    if (pointInGeometry(at, event.geometry, buffer)) return event;
  }
  return null;
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

  for (const resource of nearby) {
    // Freshness and status first (the existing gate), then hazard containment
    // as the final check on anything still recommendable: a fresh, open
    // facility inside an active severe hazard footprint is Feather River
    // Hospital — its own record says "open" and it must still be rejected.
    const reason = classifyResource(resource, ctx.now);
    if (reason !== null) {
      rejected.push({ resource, rejected_reason: reason });
    } else if (containingHazard(resource, hazards, ctx.now)) {
      rejected.push({ resource, rejected_reason: "inside_hazard_zone" });
    } else {
      recommendable.push(resource);
    }
  }

  return { recommendable, rejected };
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

  const events = ctx.store.queryEvents({ statuses: ["active"], now: ctx.now });
  const rejection = classifyResource(destination, ctx.now) ??
    (containingHazard(destination, events, ctx.now) ? "inside_hazard_zone" : null);
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
  const from: LonLat = [args.from_lon, args.from_lat];
  const to = destination.location.coordinates as LonLat;

  const { candidates, best } = calculateRoutes({ from, to, events, now: ctx.now });

  // Evidence = every hazard the router weighed, not just the ones on the
  // chosen line — "avoids N hazards" has to be countable.
  const evidenceEventIds = [
    ...new Set(candidates.flatMap((c) => c.intersecting_event_ids)),
  ];

  return {
    candidates,
    recommendation: best
      ? buildRecommendation(best, destination, evidenceEventIds, ctx.now)
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
  const stalePenalty = Math.max(
    0,
    candidate.risk_score - candidate.duration_min - hazardPenalty,
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

export const tools = {
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
export function gatherEvidence(
  ctx: ToolContext,
  question: string,
  at: LonLat,
  opts: { radius_m?: number } = {},
): EvidenceBundle {
  const { intent } = planQuery(question);
  const [lon, lat] = at;
  const radius = opts.radius_m ?? DEFAULT_RESOURCE_RADIUS_M;

  const typeFilter: EventType[] | undefined =
    intent === "roads_to_avoid" ? HAZARD_EVENT_TYPES : undefined;

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

  const bundle: EvidenceBundle = { events, source_records: sourceRecords };

  if (intent === "nearest_shelter" || intent === "resource_query") {
    const resourceType: ResourceType | undefined =
      intent === "nearest_shelter" ? "shelter" : undefined;
    const { recommendable, rejected } = tools.get_nearby_resources(ctx, {
      lat,
      lon,
      resource_type: resourceType,
      radius_m: radius,
    });
    bundle.resources = rankResources(question, recommendable);
    bundle.rejected_resources = rejected as RejectedResource[];

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
