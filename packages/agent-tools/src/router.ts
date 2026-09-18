/**
 * Route-risk engine.
 *
 * Dijkstra over the bounded demo lattice, then k-alternatives by penalising the
 * edges already used and rerunning. Candidates that cross a reported closure or
 * an evacuation zone are ELIMINATED, not down-ranked — the recommendation only
 * ever chooses among survivors.
 *
 * This is a demonstration router. Every response carries
 * `routing: "demonstration"` and the recommendation language is
 * "lowest-risk … currently available", never "safe".
 */
import {
  type CanonicalEvent,
  type LonLat,
  type Resource,
  type RouteCandidate,
  type RouteRecommendation,
  eventMaxAge,
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

const MAX_ALTERNATIVES = 4;
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
      if (visited.has(entry.to)) continue;
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

export function calculateRoutes(input: RouteInput, graph: RoadGraph = demoGraph): RouteResult {
  const adjacency = buildAdjacency(graph);
  const start = nearestNode(graph, input.from);
  const goal = nearestNode(graph, input.to);
  const activeEvents = input.events.filter((e) => e.status === "active");

  // Off-graph request: refuse rather than route someone through a
  // neighbourhood they are not in.
  if (start.distance_m > MAX_SNAP_M || goal.distance_m > MAX_SNAP_M) {
    return { candidates: [noPathCandidate(input.from, input.to)], best: null };
  }

  const penalties = new Map<string, number>();
  const candidates: RouteCandidate[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < MAX_ALTERNATIVES; i++) {
    const path = dijkstra(adjacency, start.id, goal.id, penalties);
    if (path === null) break;

    const signature = path.map((e) => e.edgeKey).join(">");
    if (!seen.has(signature)) {
      seen.add(signature);
      candidates.push(
        scorePath(`route_${candidates.length + 1}`, path, input, activeEvents),
      );
    }

    if (path.length === 0) break;
    for (const entry of path) {
      penalties.set(entry.edgeKey, (penalties.get(entry.edgeKey) ?? 1) * PENALTY_FACTOR);
    }
  }

  if (candidates.length === 0) {
    const fallback = noPathCandidate(input.from, input.to);
    return { candidates: [fallback], best: null };
  }

  let best: RouteCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.eliminated) continue;
    if (best === null || candidate.risk_score < best.risk_score) best = candidate;
  }

  return { candidates, best };
}

function scorePath(
  routeId: string,
  path: AdjacencyEntry[],
  input: RouteInput,
  events: CanonicalEvent[],
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
  const checked: { geometry: LonLat[]; length_m: number; includeEndpoints?: boolean }[] =
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
      checked.push({ geometry, length_m, includeEndpoints: true });
    }
  }

  for (const entry of checked) {
    let edgeHazardCounted = false;
    for (const event of events) {
      if (!edgeIntersectsEvent(entry.geometry, event, entry.includeEndpoints)) continue;
      intersecting.add(event.event_id);

      if (event.event_type === "road_closure") {
        eliminated = true;
        if (rejectedReason === null) rejectedReason = "closure_intersection";
      } else if (event.event_type === "evacuation_order") {
        eliminated = true;
        // An evacuation zone is the stronger signal — it overrides a closure.
        rejectedReason = "evacuation_zone";
      } else if (!edgeHazardCounted) {
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

  const riskScore = duration + hazardExposure / 100 + (hasStaleEvidence ? 5 : 0);

  return {
    route_id: routeId,
    geometry: { type: "LineString", coordinates },
    distance_m: distance,
    duration_min: duration,
    hazard_exposure_m: hazardExposure,
    intersecting_event_ids: [...intersecting],
    risk_score: riskScore,
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
): RouteRecommendation {
  const avoided = evidenceEventIds.filter(
    (id) => !best.intersecting_event_ids.includes(id),
  ).length;
  const minutes = Math.max(1, Math.round(best.duration_min));

  return {
    recommendation_id: `rec_${destination.resource_id}_${now.getTime()}`,
    route_id: best.route_id,
    destination_resource_id: destination.resource_id,
    summary:
      `Lowest-risk route currently available to ${destination.name} — ` +
      `${minutes} min, avoids ${avoided} reported hazard${avoided === 1 ? "" : "s"}. ` +
      `Conditions may change.`,
    duration_min: best.duration_min,
    avoided_hazard_count: avoided,
    evidence_event_ids: evidenceEventIds,
    generated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + RECOMMENDATION_TTL_MS).toISOString(),
    routing: "demonstration",
  };
}
