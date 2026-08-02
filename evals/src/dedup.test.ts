/**
 * Deduplication and provenance retention (BUILD_GUIDE §7).
 *
 * The invariant under test: re-ingesting an identical record changes nothing,
 * and a second provider adds corroboration WITHOUT discarding either record.
 * Provenance is never merged away.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "@harborline/agent-tools";
import { dedupKey, makeSourceRecord, mergeEvents } from "@harborline/connectors";
import type { SourceRecord } from "@harborline/event-schema";
import { DEMO_EVENT_IDS, NOW, findEvent, findSourceRecord, seedScenario } from "./fixtures.js";

function fireFixture() {
  const { fixtures } = seedScenario();
  return {
    event: findEvent(fixtures, DEMO_EVENT_IDS.fire),
    record: findSourceRecord(fixtures, "demo-record-calfire"),
  };
}

/** A second, independent provider describing the same fire. */
function corroboratingRecord(): SourceRecord {
  return makeSourceRecord({
    source_record_id: "eval-record-bcem-fire",
    event_id: DEMO_EVENT_IDS.fire,
    provider: "Butte County Emergency Management",
    provider_record_id: "bcem-fire-east-chico-01",
    provider_tier: "B",
    source_url: "https://demo.harborline.local/alerts/bcem-fire",
    published_at: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
    retrieved_at: NOW.toISOString(),
    hash_input: "bcem-fire-east-chico-01",
  });
}

describe("upserting the same event twice", () => {
  it("keeps one event, one source record, and source_count 1", () => {
    const store = new MemoryStore();
    const { event, record } = fireFixture();

    store.upsertEvent(event, [record]);
    store.upsertEvent(event, [record]);

    expect(store.allEvents()).toHaveLength(1);

    const stored = store.getEvent(DEMO_EVENT_IDS.fire);
    expect(stored).not.toBeNull();
    expect(stored!.event.source_count).toBe(1);
    expect(stored!.source_records).toHaveLength(1);
    expect(stored!.source_records[0]!.source_record_id).toBe("demo-record-calfire");
  });

  it("is idempotent on the content hash", () => {
    const { record } = fireFixture();
    const replay = makeSourceRecord({
      source_record_id: record.source_record_id,
      event_id: record.event_id,
      provider: record.provider,
      provider_record_id: record.provider_record_id,
      provider_tier: record.provider_tier,
      source_url: record.source_url,
      published_at: record.published_at,
      retrieved_at: NOW.toISOString(),
      hash_input: JSON.stringify({
        id: DEMO_EVENT_IDS.fire,
        headline: fireFixture().event.headline,
        sent: fireFixture().event.last_verified_at,
      }),
    });

    expect(replay.content_hash).toBe(record.content_hash);
  });
});

describe("two providers describing one fire", () => {
  it("merges to source_count 2 and retains BOTH source records", () => {
    const store = new MemoryStore();
    const { event, record } = fireFixture();
    const second = corroboratingRecord();

    store.upsertEvent(event, [record]);
    store.upsertEvent(event, [second]);

    expect(store.allEvents()).toHaveLength(1);

    const stored = store.getEvent(DEMO_EVENT_IDS.fire)!;
    expect(stored.event.source_count).toBe(2);
    expect(stored.source_records).toHaveLength(2);
    expect(stored.source_records.map((r) => r.source_record_id).sort()).toEqual([
      "demo-record-calfire",
      "eval-record-bcem-fire",
    ]);
    expect(stored.source_records.map((r) => r.provider).sort()).toEqual([
      "Butte County Emergency Management",
      "CAL FIRE",
    ]);
    // The higher-authority tier still governs the event.
    expect(stored.event.best_tier).toBe("A");
  });

  it("gives the same dedup key to both providers' view of the event", () => {
    const { event } = fireFixture();
    const restated = mergeEvents(event, { ...event, headline: "Fire east of the Avenues" });

    expect(dedupKey(restated)).toBe(dedupKey(event));
    expect(restated.event_id).toBe(event.event_id);
  });
});
