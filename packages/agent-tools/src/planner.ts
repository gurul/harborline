import type { AccessNeed, NearbyResource, ResourceType } from "@harborline/event-schema";

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
  | "fire_nearby"
  | "air_quality"
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
/** Air questions. Checked before FIRE so "is the smoke air safe" is about air. */
const AIR = /\b(air|aqi|breath\w*|pollut\w*)\b/i;
/** Fire questions, including smoke without an air word. No "stay" or "home". */
const FIRE = /\b(fires?|wildfires?|burning|smoke|smoky|hotspots?)\b/i;

export function planQuery(question: string): QueryPlan {
  const q = question ?? "";

  if (SHELTER.test(q) || WHERE_GO.test(q) || EVACUATE.test(q)) return { intent: "nearest_shelter" };
  if (ROADS.test(q)) return { intent: "roads_to_avoid" };
  if (AIR.test(q)) return { intent: "air_quality" };
  if (FIRE.test(q)) return { intent: "fire_nearby" };
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

/** Whether a resource's record meets a need: true, false, or null when it does not say. */
export function needMet(resource: NearbyResource, need: AccessNeed): boolean | null {
  const features = resource.accessibility_features.map((f) => f.toLowerCase());
  switch (need) {
    case "wheelchair":
      return features.some((f) => /wheelchair|\bada\b|step[-_ ]?free|ramp/.test(f)) ? true : null;
    case "accessible_restroom":
      return features.some((f) => /restroom|toilet|bathroom/.test(f)) ? true : null;
    case "pets": {
      const policy = (resource.pet_policy ?? "").trim();
      if (policy === "") return null;
      if (/service animals? only|no pets|not (allowed|accepted|permitted)|prohibited/i.test(policy)) return false;
      if (/pets? (are )?(allowed|welcome|accepted)|pet[- ]friendly|^yes\b/i.test(policy)) return true;
      return null;
    }
  }
}

/** Needs the question text itself asks for. */
export function needsFromQuestion(question: string): AccessNeed[] {
  return /\b(wheelchair|accessib\w*|ada|disab\w*|mobility)\b/i.test(question ?? "") ? ["wheelchair"] : [];
}

export interface RankOptions {
  access_needs?: AccessNeed[];
  /** A resource the caller asked for by id: ranked first when present. */
  preferred_resource_id?: string;
}

/**
 * Choose the destination before routing or wording so both use the same order.
 *
 * Deterministic: the caller's chosen resource first; then resources whose
 * record contradicts no stated need; then the most needs recorded as met;
 * then distance. A record that says nothing about a need is neither credited
 * nor excluded.
 */
export function rankResources(
  question: string,
  resources: NearbyResource[],
  opts: RankOptions = {},
): NearbyResource[] {
  const needs = [...new Set([...needsFromQuestion(question), ...(opts.access_needs ?? [])])];
  const score = (r: NearbyResource) => {
    let met = 0;
    let contradicted = 0;
    for (const need of needs) {
      const v = needMet(r, need);
      if (v === true) met++;
      else if (v === false) contradicted++;
    }
    return { met, contradicted };
  };
  return [...resources].sort((a, b) => {
    if (opts.preferred_resource_id) {
      const pa = Number(a.resource_id === opts.preferred_resource_id);
      const pb = Number(b.resource_id === opts.preferred_resource_id);
      if (pa !== pb) return pb - pa;
    }
    if (needs.length > 0) {
      const sa = score(a);
      const sb = score(b);
      if (sa.contradicted !== sb.contradicted) return sa.contradicted - sb.contradicted;
      if (sa.met !== sb.met) return sb.met - sa.met;
    }
    return a.distance_m - b.distance_m;
  });
}
