import {
  ResourceSchema,
  type CanonicalEvent,
  type LineString,
  type LonLat,
  type Point,
  type Polygon,
  type Resource,
  type SourceRecord,
} from "@harborline/event-schema";
import { makeEvent, makeSourceRecord, minutesBefore, stableStringify } from "../util.js";

/**
 * Deterministic Capitol Hill / Central District scenario (BUILD_GUIDE §8).
 *
 * Geography is shared verbatim with the road graph in @harborline/agent-tools:
 * N-S avenues Broadway (-122.3208), 12th (-122.3170), 15th (-122.3128),
 * 19th (-122.3079), 23rd (-122.3035); E-W streets E John (47.6205),
 * E Pine (47.6154), E Union (47.6098), E Cherry (47.6033).
 */

/** Broadway & E Pine — where the demo user is standing. */
export const DEMO_USER_LOCATION: LonLat = [-122.3215, 47.6145];

export const DEMO_EVENT_IDS = {
  flood: "demo-flood-capitol-hill",
  closure12thAve: "demo-closure-12th-ave",
  closureECherry: "demo-closure-e-cherry",
  news: "demo-news-king5-rainfall",
} as const;

export const DEMO_RESOURCE_IDS = {
  calvary: "demo-shelter-calvary-church",
  garfield: "demo-shelter-garfield-community-center",
  miller: "demo-shelter-miller-community-center",
} as const;

/** Set on the 12th Ave closure when the tier E report disputes it. */
export const CLOSURE_CONTRADICTION_NOTE =
  "Seattle DOT lists this road as closed. A newer community report claims limited movement, but it has not been officially confirmed.";

const FLOOD_POLYGON: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [-122.322, 47.599],
      [-122.299, 47.599],
      [-122.299, 47.607],
      [-122.322, 47.607],
      [-122.322, 47.599],
    ],
  ],
};

/** 12th Ave between E Pine and E John — the naive-best-route blocker. */
const CLOSURE_12TH_AVE_LINE: LineString = {
  type: "LineString",
  coordinates: [
    [-122.317, 47.6154],
    [-122.317, 47.6205],
  ],
};

/** E Cherry St between 15th Ave and 19th Ave. */
const CLOSURE_E_CHERRY_LINE: LineString = {
  type: "LineString",
  coordinates: [
    [-122.3128, 47.6033],
    [-122.3079, 47.6033],
  ],
};

/** 15th Ave & E Union — where the newsroom filed from. */
const NEWS_POINT: Point = {
  type: "Point",
  coordinates: [-122.3128, 47.6098],
};

export interface DemoFixtures {
  events: CanonicalEvent[];
  resources: Resource[];
  source_records: SourceRecord[];
}

/**
 * Build the demo scenario relative to `now`. Every timestamp is derived from
 * the passed clock so the fixture is deterministic under a frozen clock and
 * realistically fresh under a live one.
 */
export function buildDemoFixtures(now: Date): DemoFixtures {
  const retrieved_at = now.toISOString();

  const floodEvent = makeEvent(
    {
      event_id: DEMO_EVENT_IDS.flood,
      event_type: "flood",
      headline: "Flash Flood Warning — Capitol Hill and Central District",
      description:
        "Heavy rainfall over the last three hours has overwhelmed storm drains between E Union St and E Cherry St. Street flooding of 6 to 18 inches is reported on low-lying blocks, with more rain expected through the evening.",
      instructions:
        "Do not drive or walk through flooded roadways. Turn around, don't drown. Move to higher ground and remain there until the warning expires. If you are in a basement or ground-floor unit in the warned area, move to an upper floor.",
      severity: "severe",
      urgency: "immediate",
      certainty: "observed",
      status: "active",
      geometry: FLOOD_POLYGON,
      starts_at: minutesBefore(now, 45),
      ends_at: new Date(now.getTime() + 5 * 3600 * 1000).toISOString(),
      last_verified_at: minutesBefore(now, 6),
      best_tier: "A",
      source_count: 1,
    },
    now,
  );

  const closure12thAve = makeEvent(
    {
      event_id: DEMO_EVENT_IDS.closure12thAve,
      event_type: "road_closure",
      headline: "12th Ave closed between E Pine St and E John St",
      description:
        "Seattle DOT has closed 12th Ave between E Pine St and E John St after wind brought down power lines across the roadway. Crews are on scene; no reopening time has been given.",
      instructions:
        "Stay at least 30 feet away from downed lines and treat them as energized. Use an alternate north-south route.",
      severity: "severe",
      urgency: "immediate",
      certainty: "observed",
      status: "active",
      geometry: CLOSURE_12TH_AVE_LINE,
      starts_at: minutesBefore(now, 90),
      ends_at: null,
      last_verified_at: minutesBefore(now, 22),
      best_tier: "B",
      // One official record. The tier E report below disputes it; it is kept as
      // a separate source record and surfaced as a contradiction, never merged.
      source_count: 1,
      contradiction_note: CLOSURE_CONTRADICTION_NOTE,
      // Disputed by a tier E report — the official record stands, but the
      // dispute costs it some confidence.
      consistency: 0.85,
    },
    now,
  );

  const closureECherry = makeEvent(
    {
      event_id: DEMO_EVENT_IDS.closureECherry,
      event_type: "road_closure",
      headline: "E Cherry St closed between 15th Ave and 19th Ave",
      description:
        "Seattle DOT has closed E Cherry St between 15th Ave and 19th Ave due to standing water across both lanes. The block sits inside the active flood warning area.",
      instructions: "Avoid the block; do not attempt to drive through standing water.",
      severity: "moderate",
      urgency: "expected",
      certainty: "observed",
      status: "active",
      geometry: CLOSURE_E_CHERRY_LINE,
      starts_at: minutesBefore(now, 120),
      ends_at: null,
      last_verified_at: minutesBefore(now, 35),
      best_tier: "B",
      source_count: 1,
    },
    now,
  );

  const newsEvent = makeEvent(
    {
      event_id: DEMO_EVENT_IDS.news,
      event_type: "weather_warning",
      headline: "KING 5: heavy rainfall to continue across Seattle through the evening",
      description:
        "KING 5 News reports that heavy rainfall is continuing over Seattle, with the heaviest cells lingering over Capitol Hill and the Central District. The newsroom cites continued street flooding on side streets east of Broadway.",
      instructions: null,
      severity: "moderate",
      urgency: "expected",
      certainty: "likely",
      status: "active",
      geometry: NEWS_POINT,
      starts_at: minutesBefore(now, 18),
      ends_at: null,
      last_verified_at: minutesBefore(now, 18),
      best_tier: "C",
      source_count: 1,
      geographic_precision: 0.7,
    },
    now,
  );

  const events: CanonicalEvent[] = [
    floodEvent,
    closure12thAve,
    closureECherry,
    newsEvent,
  ];

  const resources: Resource[] = [
    ResourceSchema.parse({
      resource_id: DEMO_RESOURCE_IDS.calvary,
      resource_type: "shelter",
      name: "Calvary Church",
      location: { type: "Point", coordinates: [-122.3035, 47.6205] },
      address: "23rd Ave & E John St, Seattle, WA",
      operational_status: "open",
      capacity_total: 200,
      capacity_available: 120,
      accessibility_features: ["wheelchair_accessible", "accessible_restrooms"],
      pet_policy: "Pets allowed (leashed or crated)",
      contact_information: "(206) 555-0142",
      last_verified_at: minutesBefore(now, 8),
      provider: "Seattle Emergency Management",
      provider_tier: "B",
      source_url: "https://demo.harborline.local/shelters/calvary-church",
    } satisfies Resource),

    ResourceSchema.parse({
      resource_id: DEMO_RESOURCE_IDS.garfield,
      resource_type: "shelter",
      name: "Garfield Community Center",
      location: { type: "Point", coordinates: [-122.305, 47.6033] },
      address: "23rd Ave & E Cherry St, Seattle, WA",
      // Reported open, but the report is 26 hours old — past the 24 h shelter
      // freshness policy, so consumers must reject it as stale_status.
      operational_status: "open",
      capacity_total: 150,
      capacity_available: 40,
      accessibility_features: ["wheelchair_accessible"],
      pet_policy: "Service animals only",
      contact_information: "(206) 555-0177",
      last_verified_at: minutesBefore(now, 26 * 60),
      provider: "Seattle Emergency Management",
      provider_tier: "B",
      source_url: "https://demo.harborline.local/shelters/garfield-community-center",
    } satisfies Resource),

    ResourceSchema.parse({
      resource_id: DEMO_RESOURCE_IDS.miller,
      resource_type: "shelter",
      name: "Miller Community Center",
      location: { type: "Point", coordinates: [-122.3208, 47.6205] },
      address: "Broadway & E John St, Seattle, WA",
      operational_status: "full",
      capacity_total: 180,
      capacity_available: 0,
      accessibility_features: ["wheelchair_accessible"],
      pet_policy: "Service animals only",
      contact_information: "(206) 555-0163",
      last_verified_at: minutesBefore(now, 15),
      provider: "Seattle Emergency Management",
      provider_tier: "B",
      source_url: "https://demo.harborline.local/shelters/miller-community-center",
    } satisfies Resource),
  ];

  const source_records: SourceRecord[] = [
    makeSourceRecord({
      source_record_id: "demo-record-nws-flood",
      event_id: DEMO_EVENT_IDS.flood,
      provider: "NWS Seattle",
      provider_record_id: "urn:oid:2.49.0.1.840.0.demo.flood.capitol-hill",
      provider_tier: "A",
      source_url: "https://demo.harborline.local/alerts/flash-flood-warning",
      published_at: minutesBefore(now, 6),
      retrieved_at,
      hash_input: stableStringify({
        id: DEMO_EVENT_IDS.flood,
        headline: floodEvent.headline,
        sent: floodEvent.last_verified_at,
      }),
    }),

    makeSourceRecord({
      source_record_id: "demo-record-sdot-12th-ave",
      event_id: DEMO_EVENT_IDS.closure12thAve,
      provider: "Seattle DOT",
      provider_record_id: "sdot-closure-12th-ave-pine-john",
      provider_tier: "B",
      source_url: "https://demo.harborline.local/closures/12th-ave",
      published_at: minutesBefore(now, 22),
      retrieved_at,
      hash_input: stableStringify({
        id: DEMO_EVENT_IDS.closure12thAve,
        cause: "downed power lines",
        updated: closure12thAve.last_verified_at,
      }),
    }),

    makeSourceRecord({
      source_record_id: "demo-record-sdot-e-cherry",
      event_id: DEMO_EVENT_IDS.closureECherry,
      provider: "Seattle DOT",
      provider_record_id: "sdot-closure-e-cherry-15th-19th",
      provider_tier: "B",
      source_url: "https://demo.harborline.local/closures/e-cherry-st",
      published_at: minutesBefore(now, 35),
      retrieved_at,
      hash_input: stableStringify({
        id: DEMO_EVENT_IDS.closureECherry,
        cause: "standing water",
        updated: closureECherry.last_verified_at,
      }),
    }),

    makeSourceRecord({
      source_record_id: "demo-record-king5-rainfall",
      event_id: DEMO_EVENT_IDS.news,
      provider: "KING 5 News",
      provider_record_id: "king5-2026-rainfall-capitol-hill",
      provider_tier: "C",
      source_url: "https://demo.harborline.local/news/king5-heavy-rainfall",
      published_at: minutesBefore(now, 18),
      retrieved_at,
      hash_input: stableStringify({
        id: DEMO_EVENT_IDS.news,
        headline: newsEvent.headline,
      }),
    }),

    // Tier E: unverified community report contradicting the 12th Ave closure.
    // It is retained as provenance and drives contradiction_note on that event.
    // No unverified event is created from it.
    makeSourceRecord({
      source_record_id: "demo-record-social-12th-ave",
      event_id: DEMO_EVENT_IDS.closure12thAve,
      provider: "Jim Adrian",
      provider_record_id: "social-post-8814",
      provider_tier: "E",
      source_url: "https://demo.harborline.local/community/posts/8814",
      published_at: minutesBefore(now, 6),
      retrieved_at,
      raw_payload: {
        author: "Jim Adrian",
        text: "just watched three cars go up 12th past Pine, looks like people are getting through",
        verified: false,
      },
      hash_input: stableStringify({
        id: "social-post-8814",
        text: "cars passing through 12th Ave closure",
      }),
    }),
  ];

  return { events, resources, source_records };
}

/** Alias matching the exported connector API name. */
export const demoFixtures = buildDemoFixtures;
