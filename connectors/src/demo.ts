import type { Connector, ConnectorResult } from "@harborline/event-schema";
import { buildDemoFixtures } from "./demo/fixtures.js";
import { errorMessage } from "./util.js";

/**
 * Local, deterministic scenario connector (BUILD_GUIDE §8). Enabled by
 * DEMO_MODE=1. It performs no network I/O — the fixtures are seeded records,
 * labelled as such so nothing here can be mistaken for a live observation.
 */
export const demoConnector: Connector = {
  id: "demo",
  label: "Demo scenario (seeded)",
  source_tier: "A",
  expected_refresh_seconds: 3600,

  async fetch(now: Date): Promise<ConnectorResult> {
    const retrieved_at = now.toISOString();
    try {
      const { events, resources, source_records } = buildDemoFixtures(now);
      return { ok: true, retrieved_at, events, resources, source_records };
    } catch (err) {
      return { ok: false, retrieved_at, error: errorMessage(err) };
    }
  },
};
