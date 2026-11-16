/**
 * Which shelter the Now view recommends, and why the others are left out.
 *
 * Mirrors the server's resource policy: a shelter must be open, re-verified
 * inside its freshness window, have room, and not sit inside an active severe
 * hazard area. Among the rest, access needs rank first, then distance.
 */
import {
  SEVERITY_RANK,
  isStale,
  pointInGeometry,
  resourceMaxAge,
  type AssistantResponse,
  type CanonicalEvent,
  type NearbyResource,
} from "@harborline/event-schema";
import type { AccessNeed } from "./preferences";

export type ExclusionReason = "closed" | "full" | "stale" | "status_unknown" | "inside_hazard";

export const EXCLUSION_TEXT: Record<ExclusionReason, string> = {
  closed: "closed",
  full: "full",
  stale: "status not re-verified recently",
  status_unknown: "status unknown",
  inside_hazard: "inside an active hazard area",
};

export interface ShelterRanking {
  recommended: NearbyResource | null;
  /** Open, fresh shelters in ranked order (the recommended one first). */
  eligible: NearbyResource[];
  excluded: { resource: NearbyResource; reason: ExclusionReason }[];
}

function petsAccepted(resource: NearbyResource): boolean {
  const policy = resource.pet_policy?.toLowerCase() ?? "";
  if (!policy) return false;
  return !/\b(no pets|not allowed|not accepted|prohibited|service animals only)\b/.test(policy);
}

function exclusionFor(
  resource: NearbyResource,
  hazards: CanonicalEvent[],
  now: Date,
): ExclusionReason | null {
  if (resource.operational_status === "closed") return "closed";
  if (resource.operational_status === "full") return "full";
  if (resource.operational_status === "unknown") return "status_unknown";
  if (resource.capacity_available !== null && resource.capacity_available <= 0) return "full";
  if (isStale(resource.last_verified_at, resourceMaxAge(resource.resource_type), now)) {
    return "stale";
  }
  const at = resource.location.coordinates as [number, number];
  for (const hazard of hazards) {
    try {
      if (pointInGeometry(at, hazard.geometry)) return "inside_hazard";
    } catch {
      // Geometry that cannot be tested does not exclude a shelter.
    }
  }
  return null;
}

export function rankShelters(
  resources: NearbyResource[],
  events: CanonicalEvent[],
  needs: AccessNeed[],
  now: Date,
): ShelterRanking {
  const hazards = events.filter(
    (e) =>
      e.status === "active" &&
      SEVERITY_RANK[e.severity] >= SEVERITY_RANK.severe &&
      (e.geometry.type === "Polygon" || e.geometry.type === "MultiPolygon"),
  );
  const shelters = resources.filter((r) => r.resource_type === "shelter");
  const eligible: NearbyResource[] = [];
  const excluded: ShelterRanking["excluded"] = [];
  for (const shelter of shelters) {
    const reason = exclusionFor(shelter, hazards, now);
    if (reason) excluded.push({ resource: shelter, reason });
    else eligible.push(shelter);
  }

  const wantStepFree = needs.includes("step_free");
  const wantPets = needs.includes("pets");
  const wantRestroom = needs.includes("accessible_restroom");
  const hasRestroom = (r: NearbyResource) =>
    r.accessibility_features.some((f) => /restroom/i.test(f));
  const nearestOnly = needs.includes("limited_walking");

  eligible.sort((a, b) => {
    if (!nearestOnly) {
      if (wantStepFree) {
        const diff =
          Number(b.accessibility_features.length > 0) - Number(a.accessibility_features.length > 0);
        if (diff !== 0) return diff;
      }
      if (wantRestroom) {
        const diff = Number(hasRestroom(b)) - Number(hasRestroom(a));
        if (diff !== 0) return diff;
      }
      if (wantPets) {
        const diff = Number(petsAccepted(b)) - Number(petsAccepted(a));
        if (diff !== 0) return diff;
      }
    }
    return a.distance_m - b.distance_m;
  });
  excluded.sort((a, b) => a.resource.distance_m - b.resource.distance_m);

  return { recommended: eligible[0] ?? null, eligible, excluded };
}

/**
 * The place an answer names, if the answer names exactly one known place.
 *
 * Uses `destination_resource_id` when the server sends it (null means the
 * answer recommends no shelter). Otherwise it looks
 * for a shelter name in the recommended action only: the answer body also
 * names shelters it rejected, so it is not a safe place to look. When no
 * name matches, the answer offers no route: it never falls back to another
 * place.
 */
export function answerDestination(
  response: AssistantResponse,
  resources: NearbyResource[],
): NearbyResource | null {
  const explicit = (response as { destination_resource_id?: unknown }).destination_resource_id;
  if (typeof explicit === "string") {
    return resources.find((r) => r.resource_id === explicit) ?? null;
  }
  if (explicit === null) return null;
  for (const text of [response.recommended_action]) {
    if (!text) continue;
    let best: { resource: NearbyResource; index: number } | null = null;
    for (const resource of resources) {
      if (resource.resource_type !== "shelter") continue;
      const index = text.indexOf(resource.name);
      if (index >= 0 && (!best || index < best.index)) best = { resource, index };
    }
    if (best) return best.resource;
  }
  return null;
}
