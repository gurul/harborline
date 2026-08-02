/**
 * Shared eval scaffolding.
 *
 * Every suite runs against a frozen clock and the same seeded demo scenario the
 * product ships (BUILD_GUIDE §8), so an assertion that passes here is an
 * assertion about the real demo, not about a test-local invention.
 */
import { MemoryStore } from "@harborline/agent-tools";
import type { ToolContext } from "@harborline/agent-tools";
import {
  DEMO_EVENT_IDS,
  DEMO_RESOURCE_IDS,
  DEMO_USER_LOCATION,
  buildDemoFixtures,
  makeEvent,
  makeSourceRecord,
} from "@harborline/connectors";
import type { DemoFixtures } from "@harborline/connectors";
import type {
  CanonicalEvent,
  LonLat,
  NearbyResource,
  Resource,
  SourceRecord,
} from "@harborline/event-schema";
import { haversineMeters } from "@harborline/event-schema";

/** The single frozen clock every eval uses. */
export const NOW = new Date("2026-08-02T12:00:00Z");

export { DEMO_EVENT_IDS, DEMO_RESOURCE_IDS, DEMO_USER_LOCATION };

export const USER_LAT = DEMO_USER_LOCATION[1];
export const USER_LON = DEMO_USER_LOCATION[0];

export interface SeededScenario {
  store: MemoryStore;
  ctx: ToolContext;
  fixtures: DemoFixtures;
  now: Date;
}

export function recordsByEventId(records: SourceRecord[]): Map<string, SourceRecord[]> {
  const map = new Map<string, SourceRecord[]>();
  for (const record of records) {
    if (!record.event_id) continue;
    const list = map.get(record.event_id);
    if (list) list.push(record);
    else map.set(record.event_id, [record]);
  }
  return map;
}

/** Seed a MemoryStore with the demo scenario at the frozen clock. */
export function seedScenario(now: Date = NOW): SeededScenario {
  const store = new MemoryStore();
  const fixtures = buildDemoFixtures(now);
  const byEvent = recordsByEventId(fixtures.source_records);

  for (const event of fixtures.events) {
    store.upsertEvent(event, byEvent.get(event.event_id) ?? []);
  }
  for (const resource of fixtures.resources) {
    store.upsertResource(resource);
  }

  return { store, ctx: { store, now }, fixtures, now };
}

export function findEvent(fixtures: DemoFixtures, id: string): CanonicalEvent {
  const event = fixtures.events.find((e) => e.event_id === id);
  if (!event) throw new Error(`fixture event not found: ${id}`);
  return event;
}

export function findResource(fixtures: DemoFixtures, id: string): Resource {
  const resource = fixtures.resources.find((r) => r.resource_id === id);
  if (!resource) throw new Error(`fixture resource not found: ${id}`);
  return resource;
}

export function findSourceRecord(fixtures: DemoFixtures, id: string): SourceRecord {
  const record = fixtures.source_records.find((r) => r.source_record_id === id);
  if (!record) throw new Error(`fixture source record not found: ${id}`);
  return record;
}

/** Attach a distance to a fixture resource so it can stand in an EvidenceBundle. */
export function asNearby(
  resource: Resource,
  from: LonLat = DEMO_USER_LOCATION,
): NearbyResource {
  return {
    ...resource,
    distance_m: haversineMeters(from, resource.location.coordinates as LonLat),
  };
}

/**
 * A synthetic active evacuation order over the Avenues. Not part of the demo
 * scenario — it exists so validator rule 4 (contradicting an evacuation order)
 * can be exercised against a real CanonicalEvent rather than a hand-shaped
 * object literal.
 */
export function evacuationOrderEvent(now: Date = NOW): CanonicalEvent {
  return makeEvent(
    {
      event_id: "eval-evacuation-the-avenues",
      event_type: "evacuation_order",
      headline: "Evacuation order — the Avenues east of Arcadian Ave",
      description:
        "Butte County Emergency Management has ordered immediate evacuation of the area east of Arcadian Ave between E 1st Ave and E 9th Ave.",
      instructions: "Leave the area now. Do not remain in the evacuation zone.",
      severity: "extreme",
      urgency: "immediate",
      certainty: "observed",
      status: "active",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-121.839, 39.738],
            [-121.832, 39.738],
            [-121.832, 39.755],
            [-121.839, 39.755],
            [-121.839, 39.738],
          ],
        ],
      },
      starts_at: new Date(now.getTime() - 20 * 60_000).toISOString(),
      ends_at: null,
      last_verified_at: new Date(now.getTime() - 5 * 60_000).toISOString(),
      best_tier: "A",
      source_count: 1,
    },
    now,
  );
}

export function evacuationOrderRecord(now: Date = NOW): SourceRecord {
  return makeSourceRecord({
    source_record_id: "eval-record-evacuation-the-avenues",
    event_id: "eval-evacuation-the-avenues",
    provider: "Butte County Emergency Management",
    provider_record_id: "bcem-evac-2026-0802-01",
    provider_tier: "A",
    source_url: "https://demo.harborline.local/orders/evacuation-the-avenues",
    published_at: new Date(now.getTime() - 5 * 60_000).toISOString(),
    retrieved_at: now.toISOString(),
    hash_input: "eval-evacuation-the-avenues",
  });
}
