/**
 * Event read endpoints. Thin over the store — no derivation happens here.
 */
import { Hono } from "hono";
import { z } from "zod";
import { EventTypeSchema, type EventType, type LonLat } from "@harborline/event-schema";
import { store } from "../state.js";

export const DEFAULT_RADIUS_M = 5000;

const EventsQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  radius_m: z.coerce.number().positive().max(200_000).optional(),
  types: z.string().min(1).optional(),
});

function parseTypes(csv: string | undefined): EventType[] | undefined {
  if (!csv) return undefined;
  const parts = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  return z.array(EventTypeSchema).parse(parts);
}

export const eventsRoutes = new Hono();

eventsRoutes.get("/", (c) => {
  const parsed = EventsQuerySchema.safeParse({
    lat: c.req.query("lat"),
    lon: c.req.query("lon"),
    radius_m: c.req.query("radius_m"),
    types: c.req.query("types"),
  });
  if (!parsed.success) {
    return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
  }

  let types: EventType[] | undefined;
  try {
    types = parseTypes(parsed.data.types);
  } catch {
    return c.json({ error: "invalid_query", message: "unknown value in `types`" }, 400);
  }

  const { lat, lon } = parsed.data;
  const center: LonLat | undefined =
    lat !== undefined && lon !== undefined ? [lon, lat] : undefined;

  const events = store.queryEvents({
    center,
    radius_m: center ? (parsed.data.radius_m ?? DEFAULT_RADIUS_M) : undefined,
    types,
    statuses: ["active"],
    now: new Date(),
  });

  return c.json({ events });
});

eventsRoutes.get("/:id", (c) => {
  const found = store.getEvent(c.req.param("id"));
  if (!found) {
    return c.json({ error: "not_found", message: "No event with that id." }, 404);
  }
  return c.json({ event: found.event, source_records: found.source_records });
});
