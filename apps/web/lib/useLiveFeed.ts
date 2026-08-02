"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { SEVERITY_RANK, type CanonicalEvent } from "@harborline/event-schema";
import {
  DEFAULT_RADIUS_M,
  STREAM_URL,
  fetchEvents,
  type EventsResponse,
} from "./api";

export interface LiveFeedOptions {
  lat: number;
  lon: number;
  radiusM?: number;
  /**
   * Only one component should own the SSE connection per mount tree; the
   * connection is ref-counted internally, so leaving this true everywhere is
   * still a single EventSource.
   */
  subscribe?: boolean;
}

export function eventsQueryKey(lat: number, lon: number, radiusM: number): QueryKey {
  // Round the anchor so tiny GPS jitter does not churn the cache key.
  return ["events", lat.toFixed(3), lon.toFixed(3), radiusM] as const;
}

/** Severity desc, then freshness desc — matches the API's documented ordering. */
export function sortEvents(events: CanonicalEvent[]): CanonicalEvent[] {
  return [...events].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return (
      new Date(b.last_verified_at).getTime() - new Date(a.last_verified_at).getTime()
    );
  });
}

function mergeEvent(
  previous: EventsResponse | undefined,
  incoming: CanonicalEvent,
): EventsResponse {
  const existing = previous?.events ?? [];
  const index = existing.findIndex((e) => e.event_id === incoming.event_id);
  const next = index >= 0 ? existing.with(index, incoming) : [...existing, incoming];
  return { events: sortEvents(next) };
}

// --- Ref-counted SSE connection --------------------------------------------

type EventListener = (event: CanonicalEvent) => void;
type StatusListener = (connected: boolean) => void;

interface Connection {
  source: EventSource | null;
  refs: number;
  attempt: number;
  timer: number | null;
  connected: boolean;
  eventListeners: Set<EventListener>;
  statusListeners: Set<StatusListener>;
}

const connections = new Map<string, Connection>();

function backoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
}

function announce(connection: Connection, connected: boolean): void {
  connection.connected = connected;
  for (const listener of connection.statusListeners) listener(connected);
}

function open(url: string, connection: Connection): void {
  if (typeof window === "undefined" || connection.refs === 0) return;

  const source = new EventSource(url);
  connection.source = source;

  source.addEventListener("open", () => {
    connection.attempt = 0;
    announce(connection, true);
  });

  source.addEventListener("feed_update", (raw: MessageEvent<string>) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.data);
    } catch {
      return;
    }
    // The stream is a projection of records the store already validated; the
    // client only guards the shape it indexes on.
    const candidate = parsed as Partial<CanonicalEvent>;
    if (!candidate || typeof candidate.event_id !== "string") return;
    for (const listener of connection.eventListeners) {
      listener(candidate as CanonicalEvent);
    }
  });

  source.addEventListener("error", () => {
    announce(connection, false);
    source.close();
    connection.source = null;
    if (connection.refs === 0) return;
    const delay = backoffMs(connection.attempt++);
    connection.timer = window.setTimeout(() => {
      connection.timer = null;
      open(url, connection);
    }, delay);
  });
}

function subscribeToStream(
  url: string,
  onEvent: EventListener,
  onStatus: StatusListener,
): () => void {
  let connection = connections.get(url);
  if (!connection) {
    connection = {
      source: null,
      refs: 0,
      attempt: 0,
      timer: null,
      connected: false,
      eventListeners: new Set(),
      statusListeners: new Set(),
    };
    connections.set(url, connection);
  }

  const active = connection;
  active.refs += 1;
  active.eventListeners.add(onEvent);
  active.statusListeners.add(onStatus);
  onStatus(active.connected);

  if (!active.source && active.timer === null) open(url, active);

  return () => {
    active.eventListeners.delete(onEvent);
    active.statusListeners.delete(onStatus);
    active.refs -= 1;
    if (active.refs > 0) return;
    if (active.timer !== null) {
      window.clearTimeout(active.timer);
      active.timer = null;
    }
    active.source?.close();
    active.source = null;
    active.connected = false;
    connections.delete(url);
  };
}

// --- Hook -------------------------------------------------------------------

export interface LiveFeed {
  events: CanonicalEvent[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  streamConnected: boolean;
  refetch: () => void;
}

/**
 * TanStack Query for the event list plus an SSE overlay: every `feed_update`
 * frame is merged into the same cache entry, so the map, the feed and the
 * header all read one consistent set of records.
 */
export function useLiveFeed(options: LiveFeedOptions): LiveFeed {
  const { lat, lon, radiusM = DEFAULT_RADIUS_M, subscribe = true } = options;
  const queryClient = useQueryClient();
  const queryKey = eventsQueryKey(lat, lon, radiusM);
  const [streamConnected, setStreamConnected] = useState(false);

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchEvents({ lat, lon, radius_m: radiusM }, signal),
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const keySignature = JSON.stringify(queryKey);

  useEffect(() => {
    if (!subscribe || typeof window === "undefined") return;
    const key = JSON.parse(keySignature) as QueryKey;
    return subscribeToStream(
      STREAM_URL,
      (incoming) => {
        queryClient.setQueryData<EventsResponse>(key, (previous) =>
          mergeEvent(previous, incoming),
        );
      },
      setStreamConnected,
    );
  }, [keySignature, queryClient, subscribe]);

  return {
    events: query.data ? sortEvents(query.data.events) : [],
    isLoading: query.isPending,
    isError: query.isError,
    error: (query.error as Error | null) ?? null,
    streamConnected,
    refetch: () => {
      void query.refetch();
    },
  };
}
