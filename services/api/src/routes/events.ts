/**
 * Event read endpoints. Thin over the store — no derivation happens here.
 */
import { Hono } from "hono";
import { z } from "zod";
import { EventTypeSchema, type EventType, type LonLat } from "@harborline/event-schema";
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

const EventsQuerySchema = z
  .object({
    lat: latParam().optional(),
    lon: lonParam().optional(),
    radius_m: radiusParam(),
    types: z.string().min(1).optional(),
    limit: limitParam(DEFAULT_LIMIT, MAX_LIMIT),
  })
  // Half a coordinate is not a location. Accepting `lat` alone would silently
  // widen the query to the whole feed while looking like a working geo filter.
  .refine((v) => (v.lat === undefined) === (v.lon === undefined), {
    message: "`lat` and `lon` must be provided together.",
    path: ["lat"],
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
    limit: c.req.query("limit"),
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

  // Cap after the store has ordered the result, so the limit trims the tail
  // rather than an arbitrary slice.
  return c.json({ events: events.slice(0, parsed.data.limit) });
});

eventsRoutes.get("/:id", (c) => {
  const found = store.getEvent(c.req.param("id"));
  if (!found) {
    return c.json({ error: "not_found", message: "No event with that id." }, 404);
  }
  return c.json({ event: found.event, source_records: found.source_records });
});
