import { z } from "zod";

/** Minimal GeoJSON geometry schemas — the only geometry shapes Harborline stores. */

/** Longitude, degrees. Rejects out-of-range values from upstream feeds. */
export const LongitudeSchema = z.number().min(-180).max(180);
/** Latitude, degrees. */
export const LatitudeSchema = z.number().min(-90).max(90);

/** A [lon, lat] position. Every geometry type gets the same range check. */
export const PositionSchema = z.tuple([LongitudeSchema, LatitudeSchema]);

/**
 * A linear ring: at least 4 positions, explicitly closed (first === last).
 * pointInRing assumes closure; an open ring silently produces wrong
 * containment — a hazard polygon that fails to eliminate a route.
 */
const LinearRingSchema = z
  .array(PositionSchema)
  .min(4)
  .refine(
    (ring) => {
      const first = ring[0];
      const last = ring[ring.length - 1];
      return (
        first !== undefined &&
        last !== undefined &&
        first[0] === last[0] &&
        first[1] === last[1]
      );
    },
    { message: "linear ring must be closed (first position === last position)" },
  );

export const PointSchema = z.object({
  type: z.literal("Point"),
  coordinates: PositionSchema, // [lon, lat]
});

export const LineStringSchema = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(PositionSchema).min(2),
});

export const PolygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(LinearRingSchema).min(1),
});

export const MultiPolygonSchema = z.object({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(z.array(LinearRingSchema).min(1)).min(1),
});

export const GeometrySchema = z.discriminatedUnion("type", [
  PointSchema,
  LineStringSchema,
  PolygonSchema,
  MultiPolygonSchema,
]);

export type Point = z.infer<typeof PointSchema>;
export type LineString = z.infer<typeof LineStringSchema>;
export type Polygon = z.infer<typeof PolygonSchema>;
export type MultiPolygon = z.infer<typeof MultiPolygonSchema>;
export type Geometry = z.infer<typeof GeometrySchema>;

export type LonLat = [number, number];
export type BBox = [number, number, number, number]; // [west, south, east, north]

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(a: LonLat, b: LonLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Ray-casting point-in-ring test. Ring is a closed array of [lon, lat]. */
function pointInRing(pt: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersects =
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(pt: LonLat, polygon: Polygon): boolean {
  const [outer, ...holes] = polygon.coordinates;
  if (!outer || !pointInRing(pt, outer as LonLat[])) return false;
  return !holes.some((hole) => pointInRing(pt, hole as LonLat[]));
}

export function pointInGeometry(pt: LonLat, geom: Geometry, bufferM = 0): boolean {
  switch (geom.type) {
    case "Point":
      return haversineMeters(pt, geom.coordinates as LonLat) <= Math.max(bufferM, 1);
    case "LineString":
      return distanceToLineStringMeters(pt, geom.coordinates as LonLat[]) <= bufferM;
    case "Polygon":
      return pointInPolygon(pt, geom);
    case "MultiPolygon":
      return geom.coordinates.some((poly) =>
        pointInPolygon(pt, { type: "Polygon", coordinates: poly }),
      );
  }
}

/** Approximate distance from a point to a polyline, in meters (planar approx, fine at city scale). */
export function distanceToLineStringMeters(pt: LonLat, line: LonLat[]): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    best = Math.min(best, distanceToSegmentMeters(pt, line[i]!, line[i + 1]!));
  }
  return best;
}

export function distanceToSegmentMeters(pt: LonLat, a: LonLat, b: LonLat): number {
  // Project into a local equirectangular plane centered at the point.
  const kx = Math.cos((pt[1] * Math.PI) / 180) * 111_320;
  const ky = 110_574;
  const px = 0;
  const py = 0;
  const ax = (a[0] - pt[0]) * kx;
  const ay = (a[1] - pt[1]) * ky;
  const bx = (b[0] - pt[0]) * kx;
  const by = (b[1] - pt[1]) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy);
}

export function geometryCentroid(geom: Geometry): LonLat {
  switch (geom.type) {
    case "Point":
      return geom.coordinates as LonLat;
    case "LineString":
      return averageCoords(geom.coordinates as LonLat[]);
    case "Polygon":
      return averageCoords(geom.coordinates[0] as LonLat[]);
    case "MultiPolygon":
      return averageCoords(geom.coordinates.flatMap((p) => p[0] ?? []) as LonLat[]);
  }
}

function averageCoords(coords: LonLat[]): LonLat {
  const n = coords.length || 1;
  const [sx, sy] = coords.reduce(([x, y], [cx, cy]) => [x + cx, y + cy], [0, 0]);
  return [sx / n, sy / n];
}

export function bboxContains(bbox: BBox, pt: LonLat): boolean {
  const [west, south, east, north] = bbox;
  if (pt[1] < south || pt[1] > north) return false;
  // west > east means the box crosses the antimeridian (e.g. Alaska/Pacific
  // regions); longitude containment then wraps instead of being an interval.
  if (west > east) return pt[0] >= west || pt[0] <= east;
  return pt[0] >= west && pt[0] <= east;
}

