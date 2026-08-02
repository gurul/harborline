/**
 * Resource read endpoints.
 *
 * The list endpoint returns every match with its distance; it deliberately does
 * NOT filter out stale or full resources — that judgement belongs to
 * `get_nearby_resources` in the tool layer, which reports the rejection reason
 * alongside the rejection. Clients see the same records the assistant sees.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  OperationalStatusSchema,
  ResourceTypeSchema,
  type LonLat,
} from "@harborline/event-schema";
import { tools } from "@harborline/agent-tools";
import { store } from "../state.js";
import {
  invalidQueryMessage,
  issueSummary,
  latParam,
  limitParam,
  lonParam,
  radiusParam,
} from "../validation.js";

export const DEFAULT_RADIUS_M = 5000;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;

const ResourcesQuerySchema = z.object({
  lat: latParam(),
  lon: lonParam(),
  radius_m: radiusParam(),
  type: ResourceTypeSchema.optional(),
  status: OperationalStatusSchema.optional(),
  limit: limitParam(DEFAULT_LIMIT, MAX_LIMIT),
});

export const resourcesRoutes = new Hono();

resourcesRoutes.get("/", (c) => {
  const parsed = ResourcesQuerySchema.safeParse({
    lat: c.req.query("lat"),
    lon: c.req.query("lon"),
    radius_m: c.req.query("radius_m"),
    type: c.req.query("type"),
    status: c.req.query("status"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_query",
        // Name the fields that actually failed — a bad `type` must not be
        // reported as a missing coordinate.
        message: invalidQueryMessage(parsed.error),
        issues: issueSummary(parsed.error),
      },
      400,
    );
  }

  const center: LonLat = [parsed.data.lon, parsed.data.lat];
  const resources = store.queryResources({
    center,
    radius_m: parsed.data.radius_m ?? DEFAULT_RADIUS_M,
    type: parsed.data.type,
    status: parsed.data.status,
  });

  return c.json({ resources: resources.slice(0, parsed.data.limit) });
});

resourcesRoutes.get("/:id", (c) => {
  const status = tools.get_resource_status(
    { store, now: new Date() },
    { resource_id: c.req.param("id") },
  );
  if (!status) {
    return c.json({ error: "not_found", message: "No resource with that id." }, 404);
  }
  return c.json(status);
});
