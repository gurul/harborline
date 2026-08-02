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

export const DEFAULT_RADIUS_M = 5000;

const ResourcesQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radius_m: z.coerce.number().positive().max(200_000).optional(),
  type: ResourceTypeSchema.optional(),
  status: OperationalStatusSchema.optional(),
});

export const resourcesRoutes = new Hono();

resourcesRoutes.get("/", (c) => {
  const parsed = ResourcesQuerySchema.safeParse({
    lat: c.req.query("lat"),
    lon: c.req.query("lon"),
    radius_m: c.req.query("radius_m"),
    type: c.req.query("type"),
    status: c.req.query("status"),
  });
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_query",
        message: "`lat` and `lon` are required.",
        issues: parsed.error.issues,
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

  return c.json({ resources });
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
