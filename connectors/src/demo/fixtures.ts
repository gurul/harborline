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
 * Deterministic wildfire scenario over the Avenues neighborhood of Chico, CA
 * (BUILD_GUIDE §8).
 *
 * Geography is shared verbatim with the road graph in @harborline/agent-tools:
 * N-S roads The Esplanade (-121.8460), Oleander Ave (-121.8425),
 * Arcadian Ave (-121.8390), Mangrove Ave (-121.8350); E-W avenues
 * E 9th Ave (39.7525), E 7th Ave (39.7495), E 5th Ave (39.7465),
 * E 3rd Ave (39.7435), E 1st Ave (39.7405).
 */

/** Just south-west of Oleander Ave & E 1st Ave — where the demo user is standing. */
export const DEMO_USER_LOCATION: LonLat = [-121.8432, 39.7398];

export const DEMO_EVENT_IDS = {
  fire: "demo-fire-east-chico",
  closureOleander: "demo-closure-oleander-ave",
  closureMangrove: "demo-closure-mangrove-ave",
  news: "demo-news-fire-growth",
} as const;

export const DEMO_RESOURCE_IDS = {
  neighborhood: "demo-shelter-neighborhood-church",
  bidwell: "demo-shelter-bidwell-community-center",
  chico: "demo-shelter-chico-community-center",
} as const;

/** Set on the Oleander Ave closure when the tier E report disputes it. */
export const CLOSURE_CONTRADICTION_NOTE =
  "Chico Public Works lists this road as closed. A newer community report claims limited movement, but it has not been officially confirmed.";

const FIRE_POLYGON: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [-121.8365, 39.738],
      [-121.832, 39.738],
      [-121.832, 39.755],
      [-121.8365, 39.755],
      [-121.8365, 39.738],
    ],
  ],
};

/** Oleander Ave between E 3rd Ave and E 5th Ave — the naive-best-route blocker. */
const CLOSURE_OLEANDER_LINE: LineString = {
  type: "LineString",
  coordinates: [
    [-121.8425, 39.7435],
    [-121.8425, 39.7465],
  ],
};

/** Mangrove Ave between E 5th Ave and E 7th Ave. */
const CLOSURE_MANGROVE_LINE: LineString = {
  type: "LineString",
  coordinates: [
    [-121.835, 39.7465],
    [-121.835, 39.7495],
  ],
};

/** Arcadian Ave & E 5th Ave — where the newsroom filed from. */
const NEWS_POINT: Point = {
  type: "Point",
  coordinates: [-121.839, 39.7465],
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

  const fireEvent = makeEvent(
    {
      event_id: DEMO_EVENT_IDS.fire,
      event_type: "fire",
      headline: "Evacuation Warning — wind-driven vegetation fire east of the Avenues",
      description:
        "A wind-driven vegetation fire is burning west toward the Mangrove Ave corridor. Spot fires and heavy smoke are reported east of Mangrove Ave, and red flag winds are expected to continue through the evening.",
      instructions:
        "Prepare to leave now and evacuate if you feel unsafe — do not wait for a mandatory order. Stay out of the area east of Mangrove Ave. Do not drive through smoke; downed power lines may be energized.",
      severity: "severe",
      urgency: "immediate",
      certainty: "observed",
      status: "active",
      geometry: FIRE_POLYGON,
      starts_at: minutesBefore(now, 45),
      ends_at: null,
      last_verified_at: minutesBefore(now, 4),
      best_tier: "A",
      source_count: 1,
    },
    now,
  );

  const closureOleander = makeEvent(
    {
      event_id: DEMO_EVENT_IDS.closureOleander,
      event_type: "road_closure",
      headline: "Oleander Ave closed between E 3rd Ave and E 5th Ave",
      description:
        "Chico Public Works has closed Oleander Ave between E 3rd Ave and E 5th Ave after red flag winds brought down power lines across the roadway. Crews are on scene; no reopening time has been given.",
      instructions:
        "Stay at least 30 feet away from downed lines and treat them as energized. Use an alternate north-south route.",
      severity: "severe",
      urgency: "immediate",
      certainty: "observed",
      status: "active",
      geometry: CLOSURE_OLEANDER_LINE,
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

  const closureMangrove = makeEvent(
    {
      event_id: DEMO_EVENT_IDS.closureMangrove,
      event_type: "road_closure",
      headline: "Mangrove Ave closed between E 5th Ave and E 7th Ave",
      description:
        "Chico Public Works has closed Mangrove Ave between E 5th Ave and E 7th Ave for fire apparatus staging. The block sits inside the active evacuation warning area.",
      instructions: "Avoid the block; keep the corridor clear for responding crews.",
      severity: "moderate",
      urgency: "expected",
      certainty: "observed",
      status: "active",
      geometry: CLOSURE_MANGROVE_LINE,
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
      headline: "Action News Now: fire growth continues east of the Avenues",
      description:
        "Action News Now reports continued fire growth east of Mangrove Ave, with the heaviest smoke settling over the Avenues. The newsroom cites ash fall and poor visibility on side streets east of Arcadian Ave.",
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
    fireEvent,
    closureOleander,
    closureMangrove,
    newsEvent,
  ];

  const resources: Resource[] = [
    ResourceSchema.parse({
      resource_id: DEMO_RESOURCE_IDS.neighborhood,
      resource_type: "shelter",
      name: "Neighborhood Church",
      location: { type: "Point", coordinates: [-121.846, 39.7525] },
      address: "The Esplanade & E 9th Ave, Chico, CA",
      operational_status: "open",
      capacity_total: 200,
      capacity_available: 120,
      accessibility_features: ["wheelchair_accessible", "accessible_restrooms"],
      health_advisory: null,
      pet_policy: "Pets allowed (leashed or crated)",
      contact_information: "(530) 555-0142",
      last_verified_at: minutesBefore(now, 8),
      provider: "Butte County Emergency Management",
      provider_tier: "B",
      source_url: "https://demo.harborline.local/shelters/neighborhood-church",
    } satisfies Resource),

    ResourceSchema.parse({
      resource_id: DEMO_RESOURCE_IDS.bidwell,
      resource_type: "shelter",
      name: "Bidwell Community Center",
      location: { type: "Point", coordinates: [-121.835, 39.751] },
      address: "Mangrove Ave & E 9th Ave, Chico, CA",
      // Reported open, but the report is 26 hours old — past the 24 h shelter
      // freshness policy, so consumers must reject it as stale_status.
      operational_status: "open",
      capacity_total: 150,
      capacity_available: 40,
      accessibility_features: ["wheelchair_accessible"],
      health_advisory: null,
      pet_policy: "Service animals only",
      contact_information: "(530) 555-0177",
      last_verified_at: minutesBefore(now, 26 * 60),
      provider: "Butte County Emergency Management",
      provider_tier: "B",
      source_url: "https://demo.harborline.local/shelters/bidwell-community-center",
    } satisfies Resource),

    ResourceSchema.parse({
      resource_id: DEMO_RESOURCE_IDS.chico,
      resource_type: "shelter",
      name: "Chico Community Center",
      location: { type: "Point", coordinates: [-121.846, 39.7405] },
      address: "The Esplanade & E 1st Ave, Chico, CA",
      operational_status: "full",
      capacity_total: 180,
      capacity_available: 0,
      accessibility_features: ["wheelchair_accessible"],
      health_advisory: null,
      pet_policy: "Service animals only",
      contact_information: "(530) 555-0163",
      last_verified_at: minutesBefore(now, 15),
      provider: "Butte County Emergency Management",
      provider_tier: "B",
      source_url: "https://demo.harborline.local/shelters/chico-community-center",
    } satisfies Resource),
  ];

  const source_records: SourceRecord[] = [
    makeSourceRecord({
      source_record_id: "demo-record-calfire",
      event_id: DEMO_EVENT_IDS.fire,
      provider: "CAL FIRE",
      provider_record_id: "urn:calfire:demo:butte:east-chico",
      provider_tier: "A",
      source_url: "https://demo.harborline.local/alerts/evacuation-warning-east-chico",
      published_at: minutesBefore(now, 4),
      retrieved_at,
      hash_input: stableStringify({
        id: DEMO_EVENT_IDS.fire,
        headline: fireEvent.headline,
        sent: fireEvent.last_verified_at,
      }),
    }),

    makeSourceRecord({
      source_record_id: "demo-record-cpw-oleander",
      event_id: DEMO_EVENT_IDS.closureOleander,
      provider: "Chico Public Works",
      provider_record_id: "cpw-closure-oleander-3rd-5th",
      provider_tier: "B",
      source_url: "https://demo.harborline.local/closures/oleander-ave",
      published_at: minutesBefore(now, 22),
      retrieved_at,
      hash_input: stableStringify({
        id: DEMO_EVENT_IDS.closureOleander,
        cause: "downed power lines",
        updated: closureOleander.last_verified_at,
      }),
    }),

    makeSourceRecord({
      source_record_id: "demo-record-cpw-mangrove",
      event_id: DEMO_EVENT_IDS.closureMangrove,
      provider: "Chico Public Works",
      provider_record_id: "cpw-closure-mangrove-5th-7th",
      provider_tier: "B",
      source_url: "https://demo.harborline.local/closures/mangrove-ave",
      published_at: minutesBefore(now, 35),
      retrieved_at,
      hash_input: stableStringify({
        id: DEMO_EVENT_IDS.closureMangrove,
        cause: "fire apparatus staging",
        updated: closureMangrove.last_verified_at,
      }),
    }),

    makeSourceRecord({
      source_record_id: "demo-record-actionnews-fire",
      event_id: DEMO_EVENT_IDS.news,
      provider: "Action News Now",
      provider_record_id: "actionnews-2026-east-chico-fire",
      provider_tier: "C",
      source_url: "https://demo.harborline.local/news/actionnews-fire-growth",
      published_at: minutesBefore(now, 18),
      retrieved_at,
      hash_input: stableStringify({
        id: DEMO_EVENT_IDS.news,
        headline: newsEvent.headline,
      }),
    }),

    // Tier E: unverified community report contradicting the Oleander Ave closure.
    // It is retained as provenance and drives contradiction_note on that event.
    // No unverified event is created from it.
    makeSourceRecord({
      source_record_id: "demo-record-social-oleander",
      event_id: DEMO_EVENT_IDS.closureOleander,
      provider: "Jim Adrian",
      provider_record_id: "social-post-8814",
      provider_tier: "E",
      source_url: "https://demo.harborline.local/community/posts/8814",
      published_at: minutesBefore(now, 6),
      retrieved_at,
      raw_payload: {
        author: "Jim Adrian",
        text: "just watched three cars north on Oleander past 3rd, looks like people are getting through",
        verified: false,
      },
      hash_input: stableStringify({
        id: "social-post-8814",
        text: "cars passing through Oleander Ave closure",
      }),
    }),
  ];

  return { events, resources, source_records };
}

/** Alias matching the exported connector API name. */
export const demoFixtures = buildDemoFixtures;
