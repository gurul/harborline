/**
 * Liveness plus source observability. Per-connector health is part of the
 * contract: a degraded upstream must be visible, not silently absent.
 *
 * `last_error` is coarsened before it leaves the process. Raw connector error
 * strings carry upstream URLs, hostnames, API-key fragments in query strings
 * and stack fragments — none of which an unauthenticated caller needs to learn
 * that a feed is unhealthy. The full text stays in the server log, where the
 * scheduler writes it on every failed fetch.
 */
import { Hono } from "hono";
import type { SourceHealth } from "@harborline/event-schema";
import { getSourceHealth } from "../scheduler.js";
import { isDemoMode, store, uptimeSeconds } from "../state.js";

/** Public error taxonomy. Enough to triage, not enough to fingerprint. */
export type ErrorCategory = "timeout" | "upstream_error" | "bad_payload";

const TIMEOUT_PATTERN = /timeout|timed out|etimedout|abort|deadline|econnreset|socket hang up/;
const BAD_PAYLOAD_PATTERN =
  /parse|json|schema|validation|invalid|malformed|unexpected token|decode|zod/;

/**
 * Map a raw connector error string to a category. Order matters: a timeout that
 * also mentions "invalid" is still a timeout.
 */
export function categorizeError(raw: string | null): ErrorCategory | null {
  if (!raw) return null;
  const text = raw.toLowerCase();
  if (TIMEOUT_PATTERN.test(text)) return "timeout";
  if (BAD_PAYLOAD_PATTERN.test(text)) return "bad_payload";
  return "upstream_error";
}

/** Strip the raw error text, keeping every other health field intact. */
export function redactSourceHealth(sources: SourceHealth[]): SourceHealth[] {
  return sources.map((source) => ({ ...source, last_error: categorizeError(source.last_error) }));
}

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) =>
  c.json({
    status: "ok",
    uptime_s: uptimeSeconds(),
    demo_mode: isDemoMode(),
    sources: redactSourceHealth(getSourceHealth()),
    counts: {
      events: store.allEvents().length,
      resources: store.allResources().length,
    },
  }),
);
