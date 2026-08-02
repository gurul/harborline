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

function floodFixture() {
  const { fixtures } = seedScenario();
  return {
    event: findEvent(fixtures, DEMO_EVENT_IDS.flood),
    record: findSourceRecord(fixtures, "demo-record-nws-flood"),
  };
}

/** A second, independent provider describing the same flood. */
function corroboratingRecord(): SourceRecord {
  return makeSourceRecord({
    source_record_id: "eval-record-sem-flood",
    event_id: DEMO_EVENT_IDS.flood,
    provider: "Seattle Emergency Management",
    provider_record_id: "sem-flood-capitol-hill-01",
    provider_tier: "B",
    source_url: "https://demo.harborline.local/alerts/sem-flood",
    published_at: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
    retrieved_at: NOW.toISOString(),
    hash_input: "sem-flood-capitol-hill-01",
  });
}

describe("upserting the same event twice", () => {
  it("keeps one event, one source record, and source_count 1", () => {
    const store = new MemoryStore();
    const { event, record } = floodFixture();

    store.upsertEvent(event, [record]);
    store.upsertEvent(event, [record]);

    expect(store.allEvents()).toHaveLength(1);

    const stored = store.getEvent(DEMO_EVENT_IDS.flood);
    expect(stored).not.toBeNull();
    expect(stored!.event.source_count).toBe(1);
    expect(stored!.source_records).toHaveLength(1);
    expect(stored!.source_records[0]!.source_record_id).toBe("demo-record-nws-flood");
  });

  it("is idempotent on the content hash", () => {
    const { record } = floodFixture();
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
        id: DEMO_EVENT_IDS.flood,
        headline: floodFixture().event.headline,
        sent: floodFixture().event.last_verified_at,
      }),
    });

    expect(replay.content_hash).toBe(record.content_hash);
  });
});

describe("two providers describing one flood", () => {
  it("merges to source_count 2 and retains BOTH source records", () => {
    const store = new MemoryStore();
    const { event, record } = floodFixture();
    const second = corroboratingRecord();

    store.upsertEvent(event, [record]);
    store.upsertEvent(event, [second]);

    expect(store.allEvents()).toHaveLength(1);

    const stored = store.getEvent(DEMO_EVENT_IDS.flood)!;
    expect(stored.event.source_count).toBe(2);
    expect(stored.source_records).toHaveLength(2);
    expect(stored.source_records.map((r) => r.source_record_id).sort()).toEqual([
      "demo-record-nws-flood",
      "eval-record-sem-flood",
    ]);
    expect(stored.source_records.map((r) => r.provider).sort()).toEqual([
      "NWS Seattle",
      "Seattle Emergency Management",
    ]);
    // The higher-authority tier still governs the event.
    expect(stored.event.best_tier).toBe("A");
  });

  it("gives the same dedup key to both providers' view of the event", () => {
    const { event } = floodFixture();
    const restated = mergeEvents(event, { ...event, headline: "Flooding in Capitol Hill" });

    expect(dedupKey(restated)).toBe(dedupKey(event));
    expect(restated.event_id).toBe(event.event_id);
  });
});
