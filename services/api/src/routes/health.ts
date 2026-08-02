/**
 * Liveness plus source observability. Per-connector health is part of the
 * contract: a degraded upstream must be visible, not silently absent.
 */
import { Hono } from "hono";
import { getSourceHealth } from "../scheduler.js";
import { isDemoMode, store, uptimeSeconds } from "../state.js";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) =>
  c.json({
    status: "ok",
    uptime_s: uptimeSeconds(),
    demo_mode: isDemoMode(),
    sources: getSourceHealth(),
    counts: {
      events: store.allEvents().length,
      resources: store.allResources().length,
    },
  }),
);
