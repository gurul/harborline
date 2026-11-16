/**
 * Reconciliation for satellite detections.
 *
 * A zero-row fetch is a normal result for the detection feed and must expire
 * nothing; a cluster ends at its `ends_at` (newest pixel + 24 h). A fetch in
 * which one satellite's file failed is `ok:false` and must expire nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "@harborline/agent-tools";
import { detectionsToEvents, firmsConnector, parseFirmsCsv } from "@harborline/connectors";
import type { Connector, ConnectorResult } from "@harborline/event-schema";
import { getSourceHealth, resetScheduler, startScheduler } from "../../services/api/src/scheduler.js";

const AT = new Date("2026-11-16T06:00:00Z");
const HEADER = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight";
const ROW_A = "39.80,-121.80,330.0,0.4,0.4,2026-11-16,0100,N20,nominal,2.0NRT,290.0,5.0,D";
const ROW_B = "39.90,-121.60,330.0,0.4,0.4,2026-11-16,0100,N20,nominal,2.0NRT,290.0,5.0,D";

function clusters(csv: string, now: Date) {
  const parsed = parseFirmsCsv(csv);
  if (!parsed.ok) throw new Error(parsed.error);
  return detectionsToEvents(parsed.rows, now, now.toISOString());
}

afterEach(() => {
  resetScheduler();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("detections: reconciliation and zero rows", () => {
  it("[A,B] -> [A] expires B; [] keeps A; A disappears from queries after ends_at", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(AT);
    const store = new MemoryStore();
    let call = 0;
    const sequence = (now: Date): ConnectorResult[] => {
      const both = clusters([HEADER, ROW_A, ROW_B].join("\n"), now);
      const onlyA = clusters([HEADER, ROW_A].join("\n"), now);
      return [
        { ok: true, retrieved_at: now.toISOString(), resources: [], ...both },
        { ok: true, retrieved_at: now.toISOString(), resources: [], ...onlyA },
        { ok: true, retrieved_at: now.toISOString(), resources: [], events: [], source_records: [] },
      ];
    };
    const fake: Connector = {
      id: "fake-firms",
      label: "fake detections",
      source_tier: "C",
      expected_refresh_seconds: 1,
      zero_rows_expected: true,
      async fetch(now) {
        const all = sequence(now);
        return all[Math.min(call++, all.length - 1)]!;
      },
    };
    const [idA, idB] = clusters([HEADER, ROW_A, ROW_B].join("\n"), AT).events.map((e) => e.event_id);

    await startScheduler({ store, demoMode: false, connectors: [fake] });
    await vi.advanceTimersByTimeAsync(10);
    expect(store.getEvent(idB!)!.event.status).toBe("active");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getEvent(idB!)!.event.status).toBe("expired");
    expect(store.getEvent(idA!)!.event.status).toBe("active");
    await vi.advanceTimersByTimeAsync(1_000);
    // The zero-row fetch is a success and expires nothing.
    expect(store.getEvent(idA!)!.event.status).toBe("active");
    const health = getSourceHealth().find((h) => h.id === "fake-firms")!;
    expect(health.healthy).toBe(true);
    expect(health.zero_rows_expected).toBe(true);
    expect(health.last_success_records).toEqual({ events: 0, resources: 0, observations: 0 });

    const active = (now: Date) =>
      store.queryEvents({ now, types: ["fire_detection"], statuses: ["active"] }).map((e) => e.event_id);
    expect(active(new Date(AT.getTime() + 18 * 3600_000))).toContain(idA);
    // Pixel at 01:00 UTC + 24 h = 01:00 the next day.
    expect(active(new Date("2026-11-17T01:01:00Z"))).not.toContain(idA);
  });

  it("a fetch where one satellite file fails is ok:false and expires nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(AT);
    const store = new MemoryStore();
    let poll = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const second = poll >= 2;
      poll++;
      if (url.includes("noaa-21")) {
        return second ? new Response("unavailable", { status: 503 }) : new Response(`${HEADER}\n${ROW_B.replace("N20", "N21")}\n`);
      }
      return new Response(`${HEADER}\n${ROW_A}\n`);
    }));
    const slow = { ...firmsConnector, expected_refresh_seconds: 1 };

    await startScheduler({ store, demoMode: false, connectors: [slow] });
    await vi.advanceTimersByTimeAsync(10);
    const ids = store.queryEvents({ now: new Date(), types: ["fire_detection"] }).map((e) => e.event_id);
    expect(ids).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_000);
    const health = getSourceHealth().find((h) => h.id === "firms-viirs")!;
    expect(health.healthy).toBe(false);
    expect(health.last_error).toMatch(/NOAA-21 file: HTTP 503/);
    for (const id of ids) expect(store.getEvent(id)!.event.status).toBe("active");
  });
});
