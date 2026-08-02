"use client";

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  SEVERITY_RANK,
  geometryCentroid,
  haversineMeters,
  type CanonicalEvent,
  type LonLat,
} from "@harborline/event-schema";
import { fetchEvent, type EventDetailResponse } from "../lib/api";
import {
  CONFIDENCE_CLASS,
  CONFIDENCE_TEXT,
  EVENT_TYPE_LABEL,
  SEVERITY_TEXT_CLASS,
  formatAge,
  formatDistance,
  useNow,
} from "../lib/format";
import { useLiveFeed } from "../lib/useLiveFeed";
import { useAppState } from "./AppState";

type TabKey = "all" | "official" | "nearby" | "weather";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "official", label: "Official" },
  { key: "nearby", label: "Nearby" },
  { key: "weather", label: "Weather" },
];

const NEARBY_RADIUS_M = 3_000;
/** Provider names are resolved from source records; cap the lookups per render. */
const DETAIL_LOOKUP_LIMIT = 15;

function distanceFromUser(event: CanonicalEvent, user: LonLat): number {
  return haversineMeters(user, geometryCentroid(event.geometry));
}

function filterEvents(
  events: CanonicalEvent[],
  tab: TabKey,
  user: LonLat,
): CanonicalEvent[] {
  switch (tab) {
    case "official":
      return events.filter((e) => e.best_tier === "A" || e.best_tier === "B");
    case "nearby":
      return events.filter((e) => distanceFromUser(e, user) <= NEARBY_RADIUS_M);
    case "weather":
      return events.filter(
        (e) => e.event_type === "weather_warning" || e.event_type === "flood",
      );
    case "all":
    default:
      return events;
  }
}

export function FeedPanel() {
  const { user, selectedEventId, setSelectedEventId } = useAppState();
  const now = useNow(30_000);
  const [tab, setTab] = useState<TabKey>("all");

  const { events, isLoading, isError, error, streamConnected } = useLiveFeed({
    lat: user.lat,
    lon: user.lon,
  });

  const userLonLat = useMemo<LonLat>(() => [user.lon, user.lat], [user.lon, user.lat]);

  const visible = useMemo(
    () => filterEvents(events, tab, userLonLat),
    [events, tab, userLonLat],
  );

  const pinned = useMemo(() => {
    const active = visible.filter((e) => e.status === "active");
    if (active.length === 0) return null;
    return active.reduce((best, event) =>
      SEVERITY_RANK[event.severity] > SEVERITY_RANK[best.severity] ? event : best,
    );
  }, [visible]);

  const rest = useMemo(
    () => visible.filter((e) => e.event_id !== pinned?.event_id),
    [visible, pinned],
  );

  // Provider names live on source records, never on the event itself — look them
  // up rather than inferring a publisher from the event.
  const lookupIds = useMemo(
    () => visible.slice(0, DETAIL_LOOKUP_LIMIT).map((e) => e.event_id),
    [visible],
  );

  const detailQueries = useQueries({
    queries: lookupIds.map((id) => ({
      queryKey: ["event", id],
      queryFn: ({ signal }: { signal?: AbortSignal }) => fetchEvent(id, signal),
      staleTime: 60_000,
      retry: 0 as const,
    })),
  });

  const providersByEvent = useMemo(() => {
    const map = new Map<string, string[]>();
    detailQueries.forEach((query, index) => {
      const id = lookupIds[index];
      const data = query.data as EventDetailResponse | undefined;
      if (!id || !data) return;
      const providers = [...new Set(data.source_records.map((r) => r.provider))];
      if (providers.length > 0) map.set(id, providers);
    });
    return map;
  }, [detailQueries, lookupIds]);

  return (
    <section
      aria-label="Live event feed"
      className="flex min-h-[420px] flex-col overflow-hidden rounded-2xl border border-hl-line bg-hl-panel lg:min-h-0"
    >
      <div className="flex items-center justify-between gap-3 border-b border-hl-line-soft px-4 pt-4 pb-3">
        <h2 className="text-xs font-semibold tracking-[0.18em] text-hl-muted uppercase">
          Live feed
        </h2>
        <span className="text-[10px] text-hl-dim">
          {streamConnected ? "streaming" : "polling"} · {events.length} records
        </span>
      </div>

      <div
        role="tablist"
        aria-label="Feed filters"
        className="flex flex-wrap gap-2 px-4 py-3"
      >
        {TABS.map((entry) => {
          const active = tab === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(entry.key)}
              className={[
                "inline-flex min-h-11 items-center rounded-full border px-4 text-xs font-medium transition-colors",
                active
                  ? "border-white/25 bg-white/95 text-hl-bg"
                  : "border-hl-line bg-hl-raised text-hl-muted hover:text-white",
              ].join(" ")}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 pt-1 pb-4">
        {isLoading ? <FeedSkeleton /> : null}

        {isError ? (
          <p className="rounded-2xl border border-hl-line bg-hl-raised p-4 text-xs text-hl-muted">
            Could not reach the Harborline service
            {error?.message ? ` (${error.message})` : ""}. Nothing is shown rather
            than something unverified.
          </p>
        ) : null}

        {!isLoading && !isError && visible.length === 0 ? (
          <p className="rounded-2xl border border-hl-line bg-hl-raised p-4 text-xs text-hl-muted">
            No records in this view.
          </p>
        ) : null}

        {pinned ? (
          <FeedCard
            event={pinned}
            now={now}
            user={userLonLat}
            providers={providersByEvent.get(pinned.event_id)}
            pinnedTop
            selected={selectedEventId === pinned.event_id}
            onSelect={setSelectedEventId}
          />
        ) : null}

        {rest.map((event) => (
          <FeedCard
            key={event.event_id}
            event={event}
            now={now}
            user={userLonLat}
            providers={providersByEvent.get(event.event_id)}
            selected={selectedEventId === event.event_id}
            onSelect={setSelectedEventId}
          />
        ))}
      </div>
    </section>
  );
}

interface FeedCardProps {
  event: CanonicalEvent;
  now: Date;
  user: LonLat;
  providers?: string[];
  pinnedTop?: boolean;
  selected: boolean;
  onSelect: (eventId: string) => void;
}

function FeedCard({
  event,
  now,
  user,
  providers,
  pinnedTop = false,
  selected,
  onSelect,
}: FeedCardProps) {
  const distance = distanceFromUser(event, user);

  return (
    <article
      className={[
        "rounded-2xl border bg-hl-raised transition-colors",
        pinnedTop
          ? "border-hl-line border-l-4 border-l-hl-amber"
          : "border-hl-line-soft",
        selected ? "ring-1 ring-hl-teal/60" : "",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={() => onSelect(event.event_id)}
        aria-label={`Open ${event.headline} on the map`}
        className="w-full rounded-2xl p-4 text-left"
      >
        {pinnedTop ? (
          <p className="mb-2 text-[10px] font-semibold tracking-[0.16em] text-hl-amber uppercase">
            Highest severity · active
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={[
              "rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-wide uppercase",
              CONFIDENCE_CLASS[event.confidence_label],
            ].join(" ")}
          >
            {CONFIDENCE_TEXT[event.confidence_label]}
          </span>
          <span className="rounded-full border border-hl-line bg-hl-panel px-2.5 py-1 text-[10px] text-hl-muted">
            {EVENT_TYPE_LABEL[event.event_type]}
          </span>
          <span
            className={["text-[10px] font-medium", SEVERITY_TEXT_CLASS[event.severity]].join(
              " ",
            )}
          >
            {event.severity}
          </span>
        </div>

        <p className="mt-2 text-[11px] text-hl-dim">
          {providers?.length ? providers.join(", ") : `Tier ${event.best_tier}`} ·{" "}
          {formatAge(event.last_verified_at, now)} · {formatDistance(distance)} away
        </p>

        <h3 className="mt-2 text-sm leading-snug font-semibold text-white">
          {event.headline}
        </h3>
        <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-hl-muted">
          {event.description}
        </p>

        <div className="mt-3 flex items-center justify-between text-[10px] text-hl-dim">
          <span>
            {event.source_count} {event.source_count === 1 ? "source" : "sources"}
          </span>
          {event.status !== "active" ? (
            <span className="uppercase">{event.status}</span>
          ) : null}
        </div>

        {event.contradiction_note ? (
          <p className="mt-3 rounded-xl border border-hl-amber/30 bg-hl-amber-soft/60 p-2.5 text-[11px] italic text-hl-amber">
            {event.contradiction_note}
          </p>
        ) : null}
      </button>
    </article>
  );
}

function FeedSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="animate-pulse rounded-2xl border border-hl-line-soft bg-hl-raised p-4"
        >
          <div className="h-3 w-24 rounded-full bg-hl-line" />
          <div className="mt-3 h-3.5 w-3/4 rounded-full bg-hl-line" />
          <div className="mt-2 h-3 w-full rounded-full bg-hl-line/70" />
          <div className="mt-2 h-3 w-2/3 rounded-full bg-hl-line/70" />
        </div>
      ))}
    </div>
  );
}

export default FeedPanel;
