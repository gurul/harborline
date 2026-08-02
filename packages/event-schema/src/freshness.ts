import type { EventType } from "./events.js";
import type { ResourceType } from "./resources.js";

/**
 * Maximum acceptable age, in seconds, before a record is considered STALE.
 * Stale records are still displayed (with their age) but are EXCLUDED from
 * recommendations and must never be described as current.
 */
export const FRESHNESS_POLICY: {
  events: Record<EventType, number>;
  resources: Record<ResourceType, number>;
} = {
  events: {
    flood: 2 * 3600,
    road_closure: 4 * 3600,
    power_outage: 2 * 3600,
    earthquake: 24 * 3600,
    fire: 3600,
    landslide: 12 * 3600,
    shelter_open: 24 * 3600,
    shelter_full: 2 * 3600,
    transit_disruption: 2 * 3600,
    evacuation_order: 12 * 3600,
    weather_warning: 6 * 3600,
  },
  resources: {
    shelter: 24 * 3600,
    hospital: 7 * 24 * 3600,
    cooling_center: 24 * 3600,
    food_water: 12 * 3600,
    charging: 12 * 3600,
    transport_hub: 6 * 3600,
  },
};

/**
 * Tolerance, in seconds, for a `last_verified_at` that sits ahead of `now`.
 *
 * Small forward skew is normal: upstream feeds stamp records from their own
 * clocks, and a request can be served a few seconds before a timestamp the
 * publisher already wrote. 10 minutes absorbs that without letting it become a
 * loophole.
 */
export const MAX_FUTURE_SKEW_SECONDS = 600;

/**
 * Age of a record in seconds, floored at 0.
 *
 * A timestamp more than MAX_FUTURE_SKEW_SECONDS ahead of `now` returns
 * POSITIVE_INFINITY, which makes the record maximally stale. Without this, a
 * clock-skewed or attacker-supplied future timestamp would clamp to age 0 and
 * be treated as permanently fresh — the record could never expire, could never
 * be excluded from a recommendation, and would always outrank correctly
 * stamped records. Failing stale is the safe direction: the record is still
 * displayed with its age, it just cannot back a current-status claim.
 */
export function ageSeconds(lastVerifiedAt: string, now: Date): number {
  const deltaSeconds = (now.getTime() - new Date(lastVerifiedAt).getTime()) / 1000;
  if (deltaSeconds < -MAX_FUTURE_SKEW_SECONDS) return Number.POSITIVE_INFINITY;
  return Math.max(0, deltaSeconds);
}

export function isStale(
  lastVerifiedAt: string,
  maxAgeSeconds: number,
  now: Date,
): boolean {
  return ageSeconds(lastVerifiedAt, now) > maxAgeSeconds;
}

export function eventMaxAge(eventType: EventType): number {
  return FRESHNESS_POLICY.events[eventType];
}

export function resourceMaxAge(resourceType: ResourceType): number {
  return FRESHNESS_POLICY.resources[resourceType];
}

/** Human-readable age, e.g. "8 min ago", "2 h ago". */
export function formatAge(lastVerifiedAt: string, now: Date): string {
  const s = ageSeconds(lastVerifiedAt, now);
  // Guard the future-skew sentinel so it never renders as "Infinity d ago".
  if (!Number.isFinite(s)) return "timestamp not usable (source clock ahead)";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
