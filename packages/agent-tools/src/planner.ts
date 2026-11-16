import type { NearbyResource, ResourceType } from "@harborline/event-schema";

/**
 * Intent router. Keyword matching only — deliberately not a model call, because
 * the planner decides which structured tools run and must be inspectable.
 */
export type QueryIntent =
  | "nearest_shelter"
  | "roads_to_avoid"
  | "what_changed"
  | "area_status"
  | "resource_query"
  | "general";

export interface QueryPlan {
  intent: QueryIntent;
}

const SHELTER = /\bshelters?\b/i;
/** A request to leave is a request for a destination and a route to it. */
const EVACUATE = /\b(evacuat\w*|get out|way out|escape)\b/i;
const WHERE_GO = /\bwhere\b[\s\S]{0,40}\b(go|stay|sleep|shelter)\b/i;
const ROADS = /\b(roads?|streets?|avenues?|avoid|drive|driving|route|routes|closed|closures?)\b/i;
const CHANGED = /\b(changed|change|last hour|past hour|recent|recently|updates?|updated|new)\b/i;
const RESOURCE = /\b(transit|bus|light rail|power|outage|charge|charging|food|water|hospital|medical|clinic|cooling)\b/i;
const AREA = /\b(what|happening|affected|status|going on|situation|area|near me)\b/i;

export function planQuery(question: string): QueryPlan {
  const q = question ?? "";

  if (SHELTER.test(q) || WHERE_GO.test(q) || EVACUATE.test(q)) return { intent: "nearest_shelter" };
  if (ROADS.test(q)) return { intent: "roads_to_avoid" };
  if (CHANGED.test(q)) return { intent: "what_changed" };
  if (RESOURCE.test(q)) return { intent: "resource_query" };
  if (AREA.test(q)) return { intent: "area_status" };
  return { intent: "general" };
}

const RESOURCE_TYPES: [RegExp, ResourceType][] = [
  [/\b(hospital|medical|clinic)\b/i, "hospital"],
  [/\bcooling\b/i, "cooling_center"],
  [/\b(food|water)\b/i, "food_water"],
  [/\b(charge|charging)\b/i, "charging"],
  [/\b(transit|bus|light rail)\b/i, "transport_hub"],
];

/** The resource type a question names, so "nearest hospital" lists hospitals only. */
export function resourceTypeFor(question: string): ResourceType | undefined {
  return RESOURCE_TYPES.find(([pattern]) => pattern.test(question ?? ""))?.[1];
}

/** Choose the destination before routing or wording so both use the same order. */
export function rankResources(question: string, resources: NearbyResource[]): NearbyResource[] {
  const preferAccessibility = /\b(wheelchair|accessib\w*|ada|disab\w*|mobility)\b/i.test(question);
  return [...resources].sort((a, b) => {
    if (preferAccessibility) {
      const rank = Number(b.accessibility_features.length > 0) - Number(a.accessibility_features.length > 0);
      if (rank !== 0) return rank;
    }
    return a.distance_m - b.distance_m;
  });
}
