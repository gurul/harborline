/**
 * Environment summary for a point: nearest air-quality reading, nearest river
 * gauge, nearby fire records, and power.
 *
 * A thin read over the store through `get_environment_summary`. The response
 * shape is a published contract (docs/API.md); every value carries its
 * provider, tier, verification time and age. Power is reported as not
 * monitored unless an outage record exists: the absence of a report is never
 * stated as "no outage".
 */
import { Hono } from "hono";
import { z } from "zod";
import { tools, type EnvironmentSummary } from "@harborline/agent-tools";
import { FIRE_CONNECTOR_IDS } from "@harborline/connectors";
import { getSourceHealth } from "../scheduler.js";
import { store } from "../state.js";
import {
  invalidQueryMessage,
  issueSummary,
  latParam,
  lonParam,
  radiusParam,
} from "../validation.js";

const EnvironmentQuerySchema = z.object({
  lat: latParam(),
  lon: lonParam(),
  radius_m: radiusParam(),
});

/** True when at least one fire connector's latest fetch succeeded. */
export function fireFeedsHealthy(): boolean {
  const ids = new Set<string>(FIRE_CONNECTOR_IDS);
  return getSourceHealth().some((h) => ids.has(h.id) && h.healthy && h.last_success_at !== null);
}

/** The published contract: the tool's internal smoke section is not part of it. */
export function toEnvironmentResponse(summary: EnvironmentSummary) {
  return {
    generated_at: summary.generated_at,
    air_quality: summary.air_quality,
    stream_gauge: summary.stream_gauge,
    fire: summary.fire,
    power: summary.power,
    sources: summary.sources,
  };
}

export const environmentRoutes = new Hono();

environmentRoutes.get("/", (c) => {
  const parsed = EnvironmentQuerySchema.safeParse({
    lat: c.req.query("lat"),
    lon: c.req.query("lon"),
    radius_m: c.req.query("radius_m"),
  });
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_query",
        message: invalidQueryMessage(parsed.error),
        issues: issueSummary(parsed.error),
      },
      400,
    );
  }

  const summary = tools.get_environment_summary(
    { store, now: new Date() },
    {
      lat: parsed.data.lat,
      lon: parsed.data.lon,
      ...(parsed.data.radius_m !== undefined ? { radius_m: parsed.data.radius_m } : {}),
      fire_feeds_healthy: fireFeedsHealthy(),
    },
  );
  return c.json(toEnvironmentResponse(summary));
});
