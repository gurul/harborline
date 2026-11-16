/**
 * Route-risk engine.
 *
 * Dijkstra over the bounded demo lattice, then k-alternatives by penalising the
 * edges already used and rerunning. Candidates that cross a reported closure, an
 * evacuation zone, or a severe fire, flood or landslide area are ELIMINATED, not
 * down-ranked — the recommendation only ever chooses among survivors. When no
 * alternative survives, the search reruns on the graph with every eliminating
 * edge removed, so an open route that the k alternatives missed is still found.
 *
 * This is a demonstration router. Every response carries
 * `routing: "demonstration"` and the recommendation language is
 * "lowest-risk … currently available", never "safe".
 */
import {
  type CanonicalEvent,
  type EventType,
  type LonLat,
  type Resource,
  type RouteCandidate,
  type RouteRecommendation,
  SEVERITY_RANK,
  eventMaxAge,
  formatAge,
  haversineMeters,
  isStale,
  pointInGeometry,
} from "@harborline/event-schema";
import { type GraphEdge, type RoadGraph, demoGraph } from "./data/demo-graph.js";

/** Walking and driving are both modelled at 30 km/h for the demo. */
export const TRAVEL_SPEED_KMH = 30;
const METERS_PER_MINUTE = (TRAVEL_SPEED_KMH * 1000) / 60;

/** Hazard sampling: one point every ~40 m along an edge. */
const SAMPLE_STEP_M = 40;
/**
 * Samples inside this margin of an edge's endpoints are skipped. Two edges that
 * merely *touch* a hazard's endpoint at a shared intersection must not both be
 * flagged as crossing it — without the margin, a closure on Oleander Ave between
 * E 3rd and E 5th would eliminate every route through either intersection.
 * Must exceed HAZARD_BUFFER_M.
 */
const ENDPOINT_MARGIN_M = 40;
/** Point-in-geometry buffer, in meters. */
export const HAZARD_BUFFER_M = 30;

/**
 * Standoff radius for POINT-geometry hazards, by severity. A point geometry
 * says where a hazard is, not how big it is — an extreme event reported as a
 * single coordinate (an earthquake epicenter, a point-stamped alert) does not
 * have a 30 m footprint. The wildfire trigger-buffer literature's direction
 * applies: when extent is unknown, err conservative and widen the standoff
 * with severity rather than under-blocking.
 */
export const POINT_HAZARD_RADIUS_M: Record<CanonicalEvent["severity"], number> = {
  minor: 30,
  moderate: 100,
  severe: 250,
  extreme: 500,
};

/** Effective buffer for an event: severity-scaled for points, fixed otherwise. */
function hazardBufferMeters(event: CanonicalEvent): number {
  if (event.geometry.type === "Point") {
    return POINT_HAZARD_RADIUS_M[event.severity] ?? HAZARD_BUFFER_M;
  }
  return HAZARD_BUFFER_M;
}

/**
 * Maximum distance a request point may sit from the nearest graph node.
 *
 * The lattice covers a few square kilometres of the demo neighbourhood. Snapping a point
 * from outside it to whichever node happens to be least far away produces a
 * route through streets the user is nowhere near — and, worse, a hazard
 * assessment of those streets rather than theirs. Beyond this radius the honest
 * answer is that the demonstration graph cannot route the request.
 */
export const MAX_SNAP_M = 1500;

/**
 * Area hazards that eliminate a crossing route at severity severe or higher.
 * Point geometries are excluded: a point says where a hazard was reported, not
 * how far it reaches, so it adds exposure instead.
 */
const ZONE_HAZARD_TYPES: ReadonlySet<EventType> = new Set([
  "fire",
  "fire_perimeter",
  "flood",
  "landslide",
]);

/**
 * Fixed risk, in minutes, added per crossed event of a type that never
 * eliminates a route.
 *
 * A satellite heat detection is unconfirmed: eliminating on it would turn one
 * false-positive pixel on the only road into "no route" and refuge-in-place
 * guidance. Exposure alone (1 unit per 100 m) is too weak: the router would
 * trade a 3 minute detour for a road through a detection. The penalty is larger
 * than any detour on the demonstration graph, so a detour wins whenever one
 * exists, and the route is kept when none does.
 */
export const HAZARD_TYPE_PENALTY_MIN: Partial<
  Record<EventType, Record<CanonicalEvent["severity"], number>>
> = {
  fire_detection: { minor: 0, moderate: 15, severe: 30, extreme: 30 },
};

/** Event types the second "avoid" search routes around when it can. */
const AVOID_IF_POSSIBLE_TYPES: ReadonlySet<EventType> = new Set(["fire_detection"]);

function typePenaltyMinutes(event: CanonicalEvent): number {
  return HAZARD_TYPE_PENALTY_MIN[event.event_type]?.[event.severity] ?? 0;
}

type RejectedReason = NonNullable<RouteCandidate["rejected_reason"]>;

/**
 * Why crossing `event` eliminates a route, or null when it only adds exposure.
 * A zone that contains the user's own starting point does not eliminate:
 * every route out of it starts inside it, and the user must still be able to
 * leave.
 */
function eliminationReason(
  event: CanonicalEvent,
  originZones: ReadonlySet<string>,
): RejectedReason | null {
  if (event.event_type === "road_closure") return "closure_intersection";
  if (originZones.has(event.event_id)) return null;
  if (event.event_type === "evacuation_order") return "evacuation_zone";
  if (
    ZONE_HAZARD_TYPES.has(event.event_type) &&
    event.geometry.type !== "Point" &&
    SEVERITY_RANK[event.severity] >= SEVERITY_RANK.severe
  ) {
    return "hazard_zone";
  }
  return null;
}

/** Evacuation zones and area hazards that contain the route's origin. */
function zonesContaining(pt: LonLat, events: CanonicalEvent[]): Set<string> {
  const out = new Set<string>();
  for (const event of events) {
    if (event.event_type !== "evacuation_order" && !ZONE_HAZARD_TYPES.has(event.event_type)) {
      continue;
    }
    if (pointInGeometry(pt, event.geometry, hazardBufferMeters(event))) out.add(event.event_id);
  }
  return out;
}

const MAX_ALTERNATIVES = 4;
/** Risk added when a crossed record is past its freshness budget. */
export const STALE_PENALTY_MIN = 5;
const PENALTY_FACTOR = 1.6;
const RECOMMENDATION_TTL_MS = 10 * 60 * 1000;

export interface RouteInput {
  from: LonLat;
  to: LonLat;
  events: CanonicalEvent[];
  now: Date;
}

export interface RouteResult {
  candidates: RouteCandidate[];
  best: RouteCandidate | null;
}

interface AdjacencyEntry {
  to: string;
  edgeKey: string;
  edge: GraphEdge;
  /** Traversal geometry oriented from -> to. */
  geometry: LonLat[];
  length_m: number;
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}|${edge.to}`;
}

function polylineLength(points: LonLat[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += haversineMeters(points[i]!, points[i + 1]!);
  }
  return total;
}

function buildAdjacency(graph: RoadGraph): Map<string, AdjacencyEntry[]> {
  const adjacency = new Map<string, AdjacencyEntry[]>();
  const push = (from: string, entry: AdjacencyEntry) => {
    const list = adjacency.get(from);
    if (list) list.push(entry);
    else adjacency.set(from, [entry]);
  };

  for (const edge of graph.edges) {
    const key = edgeKey(edge);
    const forward = edge.geometry;
    const backward = [...edge.geometry].reverse();
    const length = polylineLength(forward);
    push(edge.from, { to: edge.to, edgeKey: key, edge, geometry: forward, length_m: length });
    push(edge.to, { to: edge.from, edgeKey: key, edge, geometry: backward, length_m: length });
  }
  return adjacency;
}

interface Snap {
  id: string;
  distance_m: number;
}

function nearestNode(graph: RoadGraph, pt: LonLat): Snap {
  let bestId = graph.nodes[0]?.id ?? "";
  let bestDistance = Infinity;
  for (const node of graph.nodes) {
    const d = haversineMeters(pt, node.coord);
    if (d < bestDistance) {
      bestDistance = d;
      bestId = node.id;
    }
  }
  return { id: bestId, distance_m: bestDistance };
}

/**
 * Interior sample points along an edge, one every ~SAMPLE_STEP_M, excluding a
 * margin at each end (see ENDPOINT_MARGIN_M).
 */
export function sampleEdgePoints(
  geometry: LonLat[],
  stepM: number = SAMPLE_STEP_M,
  marginM: number = ENDPOINT_MARGIN_M,
): LonLat[] {
  const segments: { a: LonLat; b: LonLat; start: number; length: number }[] = [];
  let total = 0;
  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i]!;
    const b = geometry[i + 1]!;
    const length = haversineMeters(a, b);
    segments.push({ a, b, start: total, length });
    total += length;
  }
  if (total === 0 || segments.length === 0) return geometry.length > 0 ? [geometry[0]!] : [];

  const pointAt = (distance: number): LonLat => {
    for (const seg of segments) {
      if (distance <= seg.start + seg.length || seg === segments[segments.length - 1]) {
        const t = seg.length === 0 ? 0 : (distance - seg.start) / seg.length;
        const clamped = Math.max(0, Math.min(1, t));
        return [
          seg.a[0] + (seg.b[0] - seg.a[0]) * clamped,
          seg.a[1] + (seg.b[1] - seg.a[1]) * clamped,
        ];
      }
    }
    return segments[segments.length - 1]!.b;
  };

  if (total <= 2 * marginM) return [pointAt(total / 2)];

  const points: LonLat[] = [];
  for (let d = marginM; d <= total - marginM + 1e-9; d += stepM) {
    points.push(pointAt(d));
  }
  if (points.length === 0) points.push(pointAt(total / 2));
  return points;
}

/** True when any interior sample of the edge falls within the event geometry. */
export function edgeIntersectsEvent(
  geometry: LonLat[],
  event: CanonicalEvent,
  includeEndpoints = false,
): boolean {
  const bufferM = hazardBufferMeters(event);
  const points = sampleEdgePoints(geometry, SAMPLE_STEP_M, includeEndpoints ? 0 : ENDPOINT_MARGIN_M);
  if (includeEndpoints && geometry.length > 0) {
    points.push(geometry[0]!, geometry.at(-1)!);
  }
  for (const pt of points) {
    if (pointInGeometry(pt, event.geometry, bufferM)) return true;
  }
  return false;
}

function dijkstra(
  adjacency: Map<string, AdjacencyEntry[]>,
  start: string,
  goal: string,
  penalties: Map<string, number>,
  blocked: ReadonlySet<string> = new Set(),
): AdjacencyEntry[] | null {
  const dist = new Map<string, number>([[start, 0]]);
  const prev = new Map<string, { node: string; entry: AdjacencyEntry }>();
  const visited = new Set<string>();

  for (;;) {
    let current: string | null = null;
    let currentDist = Infinity;
    for (const [node, d] of dist) {
      if (!visited.has(node) && d < currentDist) {
        current = node;
        currentDist = d;
      }
    }
    if (current === null) break;
    if (current === goal) break;
    visited.add(current);

    for (const entry of adjacency.get(current) ?? []) {
      if (visited.has(entry.to) || blocked.has(entry.edgeKey)) continue;
      const weight = entry.length_m * (penalties.get(entry.edgeKey) ?? 1);
      const next = currentDist + weight;
      if (next < (dist.get(entry.to) ?? Infinity)) {
        dist.set(entry.to, next);
        prev.set(entry.to, { node: current, entry });
      }
    }
  }

  if (start === goal) return [];
  if (!dist.has(goal)) return null;

  const path: AdjacencyEntry[] = [];
  let cursor = goal;
  while (cursor !== start) {
    const step = prev.get(cursor);
    if (!step) return null;
    path.unshift(step.entry);
    cursor = step.node;
  }
  return path;
}

function noPathCandidate(from: LonLat, to: LonLat): RouteCandidate {
  return {
    route_id: "route_none",
    geometry: { type: "LineString", coordinates: [from, to] },
    distance_m: haversineMeters(from, to),
    duration_min: 0,
    hazard_exposure_m: 0,
    intersecting_event_ids: [],
    risk_score: Number.POSITIVE_INFINITY,
    eliminated: true,
    rejected_reason: "no_path",
  };
}

/** Edges that cross an eliminating event: removed before the fallback search. */
function eliminatingEdgeKeys(
  graph: RoadGraph,
  events: CanonicalEvent[],
  originZones: ReadonlySet<string>,
): Set<string> {
  return edgesCrossing(graph, events.filter((e) => eliminationReason(e, originZones) !== null));
}

/**
 * Edges that cross an avoid-if-possible event (a satellite detection with a
 * non-zero penalty). Removed, together with the eliminating edges, for the
 * second search that looks for a detour.
 */
function avoidingEdgeKeys(graph: RoadGraph, events: CanonicalEvent[]): Set<string> {
  return edgesCrossing(
    graph,
    events.filter((e) => AVOID_IF_POSSIBLE_TYPES.has(e.event_type) && typePenaltyMinutes(e) > 0),
  );
}

function edgesCrossing(graph: RoadGraph, events: CanonicalEvent[]): Set<string> {
  const blocked = new Set<string>();
  if (events.length === 0) return blocked;
  for (const edge of graph.edges) {
    if (events.some((event) => edgeIntersectsEvent(edge.geometry, event))) {
      blocked.add(edgeKey(edge));
    }
  }
  return blocked;
}

function bestOf(candidates: RouteCandidate[]): RouteCandidate | null {
  let best: RouteCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.eliminated) continue;
    if (best === null || candidate.risk_score < best.risk_score) best = candidate;
  }
  return best;
}

function crossesAvoidable(candidate: RouteCandidate | null, events: CanonicalEvent[]): boolean {
  if (!candidate) return false;
  return candidate.intersecting_event_ids.some((id) => {
    const event = events.find((e) => e.event_id === id);
    return event !== undefined && AVOID_IF_POSSIBLE_TYPES.has(event.event_type) &&
      typePenaltyMinutes(event) > 0;
  });
}

export function calculateRoutes(input: RouteInput, graph: RoadGraph = demoGraph): RouteResult {
  const adjacency = buildAdjacency(graph);
  const start = nearestNode(graph, input.from);
  const goal = nearestNode(graph, input.to);
  const activeEvents = input.events.filter((e) => e.status === "active");
  const originZones = zonesContaining(input.from, activeEvents);

  // Off-graph request: refuse rather than route someone through a
  // neighbourhood they are not in.
  if (start.distance_m > MAX_SNAP_M || goal.distance_m > MAX_SNAP_M) {
    return { candidates: [noPathCandidate(input.from, input.to)], best: null };
  }

  const candidates: RouteCandidate[] = [];
  const seen = new Set<string>();

  const enumerate = (blocked: ReadonlySet<string>) => {
    const penalties = new Map<string, number>();
    for (let i = 0; i < MAX_ALTERNATIVES; i++) {
      const path = dijkstra(adjacency, start.id, goal.id, penalties, blocked);
      if (path === null) break;

      const signature = path.map((e) => e.edgeKey).join(">");
      if (!seen.has(signature)) {
        seen.add(signature);
        candidates.push(
          scorePath(`route_${candidates.length + 1}`, path, input, activeEvents, originZones),
        );
      }

      if (path.length === 0) break;
      for (const entry of path) {
        penalties.set(entry.edgeKey, (penalties.get(entry.edgeKey) ?? 1) * PENALTY_FACTOR);
      }
    }
  };

  // The penalised alternatives are a sample of the graph, not a search of it:
  // all of them can share one blocked edge while an open path exists. The
  // eliminated alternatives stay in the result as evidence of what was cut.
  enumerate(new Set());
  if (!candidates.some((c) => !c.eliminated)) {
    enumerate(eliminatingEdgeKeys(graph, activeEvents, originZones));
  }
  // A detection never eliminates, so the fallback above never runs for it.
  // When the best survivor crosses one, search again with the detection edges
  // (and the eliminating edges) removed. The fixed penalty then decides: a
  // detour wins when one exists; otherwise the crossing route is kept.
  if (crossesAvoidable(bestOf(candidates), activeEvents)) {
    const blocked = eliminatingEdgeKeys(graph, activeEvents, originZones);
    for (const key of avoidingEdgeKeys(graph, activeEvents)) blocked.add(key);
    enumerate(blocked);
  }

  if (candidates.length === 0) {
    const fallback = noPathCandidate(input.from, input.to);
    return { candidates: [fallback], best: null };
  }

  return { candidates, best: bestOf(candidates) };
}

function scorePath(
  routeId: string,
  path: AdjacencyEntry[],
  input: RouteInput,
  events: CanonicalEvent[],
  originZones: ReadonlySet<string>,
): RouteCandidate {
  const coordinates: LonLat[] = [input.from];
  for (const entry of path) {
    for (const pt of entry.geometry) {
      const last = coordinates[coordinates.length - 1]!;
      if (last[0] !== pt[0] || last[1] !== pt[1]) coordinates.push(pt);
    }
  }
  const lastCoord = coordinates[coordinates.length - 1]!;
  if (lastCoord[0] !== input.to[0] || lastCoord[1] !== input.to[1]) {
    coordinates.push(input.to);
  }
  if (coordinates.length < 2) coordinates.push(input.to);

  const distance = polylineLength(coordinates);
  const duration = distance / METERS_PER_MINUTE;

  const intersecting = new Set<string>();
  let hazardExposure = 0;
  let eliminated = false;
  let rejectedReason: RouteCandidate["rejected_reason"] = null;

  /**
   * Segments to hazard-check.
   *
   * When start and goal snap to the same node the Dijkstra path is empty, but
   * the user still has to walk the straight line between the two points. That
   * line gets the same sampling as any edge — otherwise a short trip that
   * crosses a closure would be reported hazard-free purely because the router
   * had no edges to inspect.
   */
  const checked: {
    geometry: LonLat[];
    length_m: number;
    includeEndpoints?: boolean;
    skipLines?: boolean;
  }[] =
    path.length > 0
      ? path.map((entry) => ({ geometry: entry.geometry, length_m: entry.length_m }))
      : [{ geometry: coordinates, length_m: distance, includeEndpoints: true }];

  // The returned geometry includes the off-node approaches, so they must be
  // assessed too. Graph-edge scoring alone leaves up to MAX_SNAP_M unchecked
  // at either end of an otherwise viable route.
  if (path.length > 0) {
    const approaches: LonLat[][] = [
      [input.from, path[0]!.geometry[0]!],
      [path[path.length - 1]!.geometry.at(-1)!, input.to],
    ];
    for (const geometry of approaches) {
      const length_m = polylineLength(geometry);
      // Even a zero-length approach checks the user's actual endpoint. The
      // junction margin on graph edges must not hide a hazard at that point.
      // A zero-length approach is only the intersection itself, though: a
      // line closure that ends there closes the road beyond it, not the
      // intersection, so line geometries are not checked against it.
      checked.push({ geometry, length_m, includeEndpoints: true, skipLines: length_m < 1 });
    }
  }

  for (const entry of checked) {
    let edgeHazardCounted = false;
    for (const event of events) {
      if (entry.skipLines && event.geometry.type === "LineString") continue;
      if (!edgeIntersectsEvent(entry.geometry, event, entry.includeEndpoints)) continue;
      intersecting.add(event.event_id);

      const reason = eliminationReason(event, originZones);
      if (reason !== null) {
        eliminated = true;
        // An evacuation zone is the stronger signal — it overrides any other.
        if (reason === "evacuation_zone" || rejectedReason === null) rejectedReason = reason;
      }
      // Exposure measures distance inside hazard areas, so an eliminated route
      // through a fire still reports it. Closures and evacuation zones are
      // boundaries, not areas of physical exposure.
      const isBoundary = event.event_type === "road_closure" || event.event_type === "evacuation_order";
      if (!isBoundary && !edgeHazardCounted) {
        hazardExposure += entry.length_m;
        edgeHazardCounted = true;
      }
    }
  }

  const hasStaleEvidence = [...intersecting].some((id) => {
    const event = events.find((e) => e.event_id === id);
    if (!event) return false;
    return isStale(event.last_verified_at, eventMaxAge(event.event_type), input.now);
  });

  let penaltyMin = 0;
  for (const id of intersecting) {
    const event = events.find((e) => e.event_id === id);
    if (event) penaltyMin += typePenaltyMinutes(event);
  }

  const riskScore =
    duration + hazardExposure / 100 + (hasStaleEvidence ? STALE_PENALTY_MIN : 0) + penaltyMin;

  return {
    route_id: routeId,
    geometry: { type: "LineString", coordinates },
    distance_m: distance,
    duration_min: duration,
    hazard_exposure_m: hazardExposure,
    intersecting_event_ids: [...intersecting],
    risk_score: riskScore,
    penalty_min: penaltyMin,
    eliminated,
    rejected_reason: rejectedReason,
  };
}

/**
 * Build the user-facing recommendation.
 *
 * The summary wording is load-bearing: "Lowest-risk route currently available"
 * plus an explicit "Conditions may change." The safety validator rejects any
 * response that promises a route is safe.
 */
export function buildRecommendation(
  best: RouteCandidate,
  destination: Resource,
  evidenceEventIds: string[],
  now: Date,
  events: CanonicalEvent[] = [],
): RouteRecommendation {
  const crossed = best.intersecting_event_ids.length;
  const avoided = evidenceEventIds.filter(
    (id) => !best.intersecting_event_ids.includes(id),
  ).length;
  const minutes = Math.max(1, Math.round(best.duration_min));
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  // The summary must never call a route hazard-free when it crosses one: a
  // kept route can still pass through a lower-severity area or a point buffer.
  const hazardClause =
    crossed > 0
      ? `passes through or near ${plural(crossed, "reported hazard area")}` +
        (avoided > 0 ? ` and avoids ${avoided} other${avoided === 1 ? "" : "s"}` : "")
      : avoided > 0
        ? `avoids ${plural(avoided, "reported hazard")}`
        : "crosses no reported hazard area";

  return {
    recommendation_id: `rec_${destination.resource_id}_${now.getTime()}`,
    route_id: best.route_id,
    destination_resource_id: destination.resource_id,
    summary:
      `Lowest-risk route currently available to ${destination.name} — ` +
      `${minutes} min, ${hazardClause}. ` +
      satelliteDisclosure(best, events, now) +
      `Conditions may change.`,
    duration_min: best.duration_min,
    avoided_hazard_count: avoided,
    evidence_event_ids: evidenceEventIds,
    generated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + RECOMMENDATION_TTL_MS).toISOString(),
    routing: "demonstration",
  };
}

/**
 * Disclosure for a kept route that crosses satellite heat detections. A
 * detection never eliminates, so the summary must say that the route passes
 * one, that no fire agency has confirmed it, and how old it is.
 */
export function satelliteDisclosure(
  route: RouteCandidate,
  events: CanonicalEvent[],
  now: Date,
): string {
  const crossed = events.filter(
    (e) => e.event_type === "fire_detection" && route.intersecting_event_ids.includes(e.event_id),
  );
  if (crossed.length === 0) return "";
  const newest = crossed.reduce((a, b) =>
    new Date(b.last_verified_at).getTime() > new Date(a.last_verified_at).getTime() ? b : a,
  );
  const n = crossed.length;
  return (
    `It includes ${n} satellite heat detection${n === 1 ? "" : "s"}, ` +
    `unconfirmed by a fire agency, detected ${formatAge(newest.last_verified_at, now)}. `
  );
}
