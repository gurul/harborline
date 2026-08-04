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
  EventType,
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
  types?: EventType[];
}

export function fetchEvents(
  query: EventsQuery,
  signal?: AbortSignal,
): Promise<EventsResponse> {
  return request<EventsResponse>(
    `/v1/events${qs({
      lat: query.lat,
      lon: query.lon,
      radius_m: query.radius_m ?? DEFAULT_RADIUS_M,
      types: query.types?.length ? query.types.join(",") : undefined,
    })}`,
    { signal },
  );
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

export function fetchResources(
  query: ResourcesQuery,
  signal?: AbortSignal,
): Promise<ResourcesResponse> {
  return request<ResourcesResponse>(
    `/v1/resources${qs({
      lat: query.lat,
      lon: query.lon,
      type: query.type,
      status: query.status,
    })}`,
    { signal },
  );
}

export interface RoutesQuery {
  from_lat: number;
  from_lon: number;
  to_resource_id: string;
}

export function fetchRoutes(
  query: RoutesQuery,
  signal?: AbortSignal,
): Promise<RoutesResponse> {
  return request<RoutesResponse>(
    `/v1/routes${qs({
      from_lat: query.from_lat,
      from_lon: query.from_lon,
      to_resource_id: query.to_resource_id,
    })}`,
    { signal },
  );
}

export interface AskBody {
  question: string;
  lat: number;
  lon: number;
}

export function askAssistant(
  body: AskBody,
  signal?: AbortSignal,
): Promise<AssistantResponse> {
  return request<AssistantResponse>("/v1/assistant/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request<HealthResponse>("/v1/health", { signal });
}
