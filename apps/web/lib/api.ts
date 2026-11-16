/**
 * Typed fetchers for the Harborline REST service (Hono, default :8787).
 *
 * Every response type is imported from `@harborline/event-schema` — the web app
 * never redefines a domain shape. The wrappers below only describe the envelope
 * each endpoint puts around those canonical types.
 */
import type {
  AssistantResponse,
  CanonicalEvent,
  NearbyResource,
  RouteCandidate,
  RouteRecommendation,
  SourceHealth,
  SourceRecord,
} from "@harborline/event-schema";

export const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"
).replace(/\/+$/, "");

export const STREAM_URL = `${API_BASE}/v1/stream`;

/** Radius used for the default feed/map query, in meters. */
export const DEFAULT_RADIUS_M = 8_000;

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// --- Response envelopes -----------------------------------------------------

export interface EventsResponse {
  events: CanonicalEvent[];
}

export interface EventDetailResponse {
  event: CanonicalEvent;
  source_records: SourceRecord[];
}

export interface ResourcesResponse {
  resources: NearbyResource[];
}

export interface RoutesResponse {
  candidates: RouteCandidate[];
  recommendation: RouteRecommendation | null;
  routing?: "demonstration";
}

export interface HealthResponse {
  status: string;
  uptime_s: number;
  sources: SourceHealth[];
}

// --- Transport --------------------------------------------------------------

/** Default per-request timeout. A hung fetch must never hang the UI with it. */
const REQUEST_TIMEOUT_MS = 20_000;

async function request<T>(
  path: string,
  init?: RequestInit & { signal?: AbortSignal },
): Promise<T> {
  // Callers may pass their own signal (TanStack Query cancellation); combine
  // it with a hard timeout so even signal-less calls cannot hang forever.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    signal,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      detail = "";
    }
    throw new ApiError(
      `${init?.method ?? "GET"} ${path} failed (${res.status})${detail ? `: ${detail}` : ""}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : "";
}

// --- Endpoints --------------------------------------------------------------

export interface EventsQuery {
  lat: number;
  lon: number;
  radius_m?: number;
  /** Event types to include. Strings, so types newer than this build pass through. */
  types?: string[];
  /** Event types to leave out (server-side `exclude_types=`). */
  exclude_types?: string[];
}

/**
 * Event types kept out of the main event list. Satellite fire detections are
 * pixel footprints, not alerts: they have their own query and map layer.
 */
export const MAIN_LIST_EXCLUDED_TYPES = ["fire_detection"] as const;

export function isMainListEvent(event: { event_type: string }): boolean {
  return !(MAIN_LIST_EXCLUDED_TYPES as readonly string[]).includes(event.event_type);
}

export async function fetchEvents(
  query: EventsQuery,
  signal?: AbortSignal,
): Promise<EventsResponse> {
  const response = await request<EventsResponse>(
    `/v1/events${qs({
      lat: query.lat,
      lon: query.lon,
      radius_m: query.radius_m ?? DEFAULT_RADIUS_M,
      types: query.types?.length ? query.types.join(",") : undefined,
      exclude_types: query.exclude_types?.length
        ? query.exclude_types.join(",")
        : undefined,
    })}`,
    { signal },
  );
  return { events: Array.isArray(response?.events) ? response.events : [] };
}

export function fetchEvent(
  eventId: string,
  signal?: AbortSignal,
): Promise<EventDetailResponse> {
  return request<EventDetailResponse>(
    `/v1/events/${encodeURIComponent(eventId)}`,
    { signal },
  );
}

export interface ResourcesQuery {
  lat: number;
  lon: number;
  type?: string;
  status?: string;
}

export async function fetchResources(
  query: ResourcesQuery,
  signal?: AbortSignal,
): Promise<ResourcesResponse> {
  const response = await request<ResourcesResponse>(
    `/v1/resources${qs({
      lat: query.lat,
      lon: query.lon,
      type: query.type,
      status: query.status,
    })}`,
    { signal },
  );
  return { resources: Array.isArray(response?.resources) ? response.resources : [] };
}


export interface AskBody {
  question: string;
  lat: number;
  lon: number;
  /** Access-need slugs from the settings sheet. Omitted when empty. */
  access_needs?: string[];
}

/**
 * Ask the assistant. Access needs ride along when present. A server that does
 * not know the field strips it; one that rejects it with a 400 gets the same
 * question again without it, so a schema mismatch never blocks an answer.
 */
export async function askAssistant(
  body: AskBody,
  signal?: AbortSignal,
): Promise<AssistantResponse> {
  const send = (payload: AskBody) =>
    request<AssistantResponse>("/v1/assistant/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  const needs = body.access_needs?.length ? body.access_needs : undefined;
  const payload: AskBody = { question: body.question, lat: body.lat, lon: body.lon };
  if (!needs) return send(payload);
  try {
    return await send({ ...payload, access_needs: needs });
  } catch (err) {
    if (err instanceof ApiError && err.status === 400 && err.message.includes("access_needs")) {
      return send(payload);
    }
    throw err;
  }
}

// --- Route to one chosen shelter ---------------------------------------------

export type ShelterRouteResult =
  | { kind: "ok"; routes: RoutesResponse }
  | { kind: "no_route"; candidates: RouteCandidate[]; message: string }
  | { kind: "unavailable"; reason: string | null; message: string };

/**
 * Route from a point to the one resource the person chose. This is the only
 * place the web app asks for a route.
 *
 * Contract used: `GET /v1/routes?from_lat&from_lon&to_resource_id`. The
 * server answers 200 with a recommendation, or 422 with `no_viable_route` or
 * `destination_unavailable`. A recommendation whose destination differs from
 * the requested id is refused: the map never draws a route to a shelter the
 * person did not pick.
 */
export async function routeToShelter(
  from: { lat: number; lon: number },
  resourceId: string,
  signal?: AbortSignal,
): Promise<ShelterRouteResult> {
  const path = `/v1/routes${qs({
    from_lat: from.lat,
    from_lon: from.lon,
    to_resource_id: resourceId,
  })}`;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(`${API_BASE}${path}`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { accept: "application/json" },
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const message = typeof body["message"] === "string" ? body["message"] : "";

  if (res.status === 422) {
    if (body["error"] === "destination_unavailable") {
      const reason = typeof body["rejected_reason"] === "string" ? body["rejected_reason"] : null;
      return { kind: "unavailable", reason, message };
    }
    const candidates = Array.isArray(body["candidates"])
      ? (body["candidates"] as RouteCandidate[])
      : [];
    return {
      kind: "no_route",
      candidates,
      message: message || "No route to this place is verified by the demonstration graph.",
    };
  }
  if (!res.ok) {
    throw new ApiError(`Routing failed (${res.status})${message ? `: ${message}` : ""}`, res.status);
  }

  const routes: RoutesResponse = {
    candidates: Array.isArray(body["candidates"]) ? (body["candidates"] as RouteCandidate[]) : [],
    recommendation: (body["recommendation"] as RouteRecommendation | null) ?? null,
    routing: "demonstration",
  };
  const destination = routes.recommendation?.destination_resource_id;
  if (routes.recommendation && destination !== resourceId) {
    throw new ApiError(
      "The router answered for a different place than the one you chose. No route is drawn.",
      409,
    );
  }
  if (!routes.recommendation) {
    return {
      kind: "no_route",
      candidates: routes.candidates,
      message: "No route to this place is verified by the demonstration graph.",
    };
  }
  return { kind: "ok", routes };
}

// --- Environment (air, river gauge, fire summary, power) ----------------------

export type ReadingStatus = "ok" | "stale" | "no_data";

interface Provenance {
  provider: string | null;
  provider_tier: string | null;
  source_url: string | null;
  last_verified_at: string | null;
  age_label: string | null;
}

export interface AirQualityReading extends Provenance {
  status: ReadingStatus;
  aqi: number | null;
  category: string | null;
  pollutant: string | null;
  name: string | null;
  distance_m: number | null;
}

export type FloodCategory =
  | "no_flooding"
  | "action"
  | "minor"
  | "moderate"
  | "major"
  | "unknown";

export interface GaugeReading extends Provenance {
  status: ReadingStatus;
  name: string | null;
  site_id: string | null;
  stage_ft: number | null;
  flood_category: FloodCategory | null;
  forecast_category: string | null;
  distance_m: number | null;
}

export interface FireSummary {
  status: "ok" | "no_data";
  detections: number;
  nearest_distance_m: number | null;
  newest_observed_at: string | null;
  newest_age_label: string | null;
  perimeters: number;
  nearest_perimeter_name: string | null;
  confirmed: boolean;
  note: string | null;
}

export interface PowerSummary {
  status: "not_monitored" | "outage_reported";
  note: string | null;
}

export interface EnvironmentSnapshot {
  generated_at: string | null;
  /** null = the section is missing from the response: treat as not connected. */
  air_quality: AirQualityReading | null;
  stream_gauge: GaugeReading | null;
  fire: FireSummary | null;
  power: PowerSummary | null;
}

export type EnvironmentResult =
  | { kind: "ok"; data: EnvironmentSnapshot }
  /** The endpoint does not exist on this server (404). */
  | { kind: "not_connected" };

type Loose = Record<string, unknown>;

function asObject(value: unknown): Loose | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Loose) : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function readingStatus(value: unknown): ReadingStatus | null {
  return value === "ok" || value === "stale" || value === "no_data" ? value : null;
}
function provenance(o: Loose): Provenance {
  return {
    provider: str(o["provider"]),
    provider_tier: str(o["provider_tier"]),
    source_url: str(o["source_url"]),
    last_verified_at: str(o["last_verified_at"]),
    age_label: str(o["age_label"]),
  };
}

const FLOOD_CATEGORIES: FloodCategory[] = [
  "no_flooding",
  "action",
  "minor",
  "moderate",
  "major",
  "unknown",
];

/** Parse defensively: an unknown or malformed section becomes null. */
export function parseEnvironment(raw: unknown): EnvironmentSnapshot {
  const root = asObject(raw) ?? {};

  let air_quality: AirQualityReading | null = null;
  const aq = asObject(root["air_quality"]);
  const aqStatus = aq ? readingStatus(aq["status"]) : null;
  if (aq && aqStatus) {
    air_quality = {
      ...provenance(aq),
      status: aqStatus,
      aqi: num(aq["aqi"]),
      category: str(aq["category"]),
      pollutant: str(aq["pollutant"]),
      name: str(aq["name"]),
      distance_m: num(aq["distance_m"]),
    };
  }

  let stream_gauge: GaugeReading | null = null;
  const sg = asObject(root["stream_gauge"]);
  const sgStatus = sg ? readingStatus(sg["status"]) : null;
  if (sg && sgStatus) {
    const category = str(sg["flood_category"]);
    stream_gauge = {
      ...provenance(sg),
      status: sgStatus,
      name: str(sg["name"]),
      site_id: str(sg["site_id"]),
      stage_ft: num(sg["stage_ft"]),
      flood_category: FLOOD_CATEGORIES.includes(category as FloodCategory)
        ? (category as FloodCategory)
        : null,
      forecast_category: str(sg["forecast_category"]),
      distance_m: num(sg["distance_m"]),
    };
  }

  let fire: FireSummary | null = null;
  const fi = asObject(root["fire"]);
  if (fi && (fi["status"] === "ok" || fi["status"] === "no_data")) {
    fire = {
      status: fi["status"],
      detections: num(fi["detections"]) ?? 0,
      nearest_distance_m: num(fi["nearest_distance_m"]),
      newest_observed_at: str(fi["newest_observed_at"]),
      newest_age_label: str(fi["newest_age_label"]),
      perimeters: num(fi["perimeters"]) ?? 0,
      nearest_perimeter_name: str(fi["nearest_perimeter_name"]),
      confirmed: fi["confirmed"] === true,
      note: str(fi["note"]),
    };
  }

  let power: PowerSummary | null = null;
  const pw = asObject(root["power"]);
  if (pw && (pw["status"] === "not_monitored" || pw["status"] === "outage_reported")) {
    power = { status: pw["status"], note: str(pw["note"]) };
  }

  return {
    generated_at: str(root["generated_at"]),
    air_quality,
    stream_gauge,
    fire,
    power,
  };
}

export async function fetchEnvironment(
  query: { lat: number; lon: number; radius_m?: number },
  signal?: AbortSignal,
): Promise<EnvironmentResult> {
  try {
    const raw = await request<unknown>(
      `/v1/environment${qs({
        lat: query.lat,
        lon: query.lon,
        radius_m: query.radius_m ?? DEFAULT_RADIUS_M,
      })}`,
      { signal },
    );
    return { kind: "ok", data: parseEnvironment(raw) };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { kind: "not_connected" };
    throw err;
  }
}

// --- Satellite fire detections ----------------------------------------------

export const FIRE_DETECTION_TYPE = "fire_detection";

export type FireDetectionsResult =
  | { kind: "ok"; events: CanonicalEvent[] }
  /** The server does not know the event type yet (400) or the route (404). */
  | { kind: "not_connected" };

/** Fire-detection footprints, fetched apart from the main event list. */
export async function fetchFireDetections(
  query: { lat: number; lon: number; radius_m?: number },
  signal?: AbortSignal,
): Promise<FireDetectionsResult> {
  try {
    const { events } = await fetchEvents(
      { ...query, types: [FIRE_DETECTION_TYPE] },
      signal,
    );
    return {
      kind: "ok",
      events: events.filter(
        (e) =>
          (e.event_type as string) === FIRE_DETECTION_TYPE &&
          (e.geometry?.type === "Polygon" || e.geometry?.type === "MultiPolygon"),
      ),
    };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 400 || err.status === 404)) {
      return { kind: "not_connected" };
    }
    throw err;
  }
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request<HealthResponse>("/v1/health", { signal });
}
