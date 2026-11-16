"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  eventMaxAge,
  geometryCentroid,
  haversineMeters,
  isStale,
  type CanonicalEvent,
  type LonLat,
} from "@harborline/event-schema";
import { fetchEvent } from "../lib/api";
import {
  CONFIDENCE_TEXT,
  SEVERITY_TONE,
  SEVERITY_WORD,
  TONE_BAR_CLASS,
  TONE_TEXT_CLASS,
  compassDirection,
  eventTypeLabel,
  formatAge,
  formatClock,
  formatDistance,
  useNow,
} from "../lib/format";
import { useLiveFeed } from "../lib/useLiveFeed";
import { useAppState } from "./AppState";
import { Button, SourceLine } from "./ui";

type FilterKey = "all" | "official" | "near" | "weather";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "official", label: "Official" },
  { key: "near", label: "Within 3 km" },
  { key: "weather", label: "Weather" },
];

const NEAR_RADIUS_M = 3_000;

function centroidOf(event: CanonicalEvent): LonLat | null {
  try {
    return geometryCentroid(event.geometry);
  } catch {
    return null;
  }
}

function distanceFrom(event: CanonicalEvent, user: LonLat): number {
  const c = centroidOf(event);
  return c ? haversineMeters(user, c) : Number.POSITIVE_INFINITY;
}

function applyFilter(events: CanonicalEvent[], key: FilterKey, user: LonLat): CanonicalEvent[] {
  switch (key) {
    case "official":
      return events.filter((e) => e.best_tier === "A" || e.best_tier === "B");
    case "near":
      return events.filter((e) => distanceFrom(e, user) <= NEAR_RADIUS_M);
    case "weather":
      return events.filter((e) => e.event_type === "weather_warning" || e.event_type === "flood");
    default:
      return events;
  }
}

export function AlertsView() {
  const { user, selection, select, clearSelection, ask } = useAppState();
  const now = useNow(30_000);
  const [filter, setFilter] = useState<FilterKey>("all");
  const feed = useLiveFeed({ lat: user.lat, lon: user.lon });
  const userPoint = useMemo<LonLat>(() => [user.lon, user.lat], [user.lon, user.lat]);

  const visible = useMemo(() => applyFilter(feed.events, filter, userPoint), [feed.events, filter, userPoint]);
  const selectedId = selection?.kind === "event" ? selection.id : null;
  const selectedEvent = selectedId ? (feed.events.find((e) => e.event_id === selectedId) ?? null) : null;

  if (selectedId) {
    return (
      <AlertDetail
        eventId={selectedId}
        fallback={selectedEvent}
        user={userPoint}
        now={now}
        onBack={clearSelection}
        onShowOnMap={() => select({ kind: "event", id: selectedId }, { revealMap: true })}
        onAsk={(headline) => ask(`What should I do about: ${headline}?`)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Filter alerts" className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={[
              "inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-meta font-medium transition-colors",
              filter === f.key
                ? "bg-white text-hl-bg"
                : "border border-hl-control-edge bg-hl-panel text-white hover:bg-hl-raised",
            ].join(" ")}
          >
            {f.label}
          </button>
        ))}
      </div>

      <SourceLine>
        {feed.isLoading
          ? "Loading alerts…"
          : feed.updatedAt
            ? `${visible.length} of ${feed.events.length} shown · updated ${formatAge(new Date(feed.updatedAt).toISOString(), now)} · within 8 km`
            : "Not loaded yet"}
      </SourceLine>

      {feed.isError ? (
        <p role="alert" className="rounded-2xl bg-hl-red-soft p-4 text-body text-hl-severe">
          Could not reach Harborline.
          {feed.hasData
            ? ` Showing alerts from ${formatClock(feed.updatedAt)}. They may be out of date.`
            : " No alerts are shown. Do not read this as all-clear."}
        </p>
      ) : null}

      {feed.isLoading ? (
        <ul aria-hidden="true" className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-24 rounded-2xl bg-hl-panel" />
          ))}
        </ul>
      ) : null}

      {!feed.isLoading && !feed.isError && visible.length === 0 ? (
        <p className="rounded-2xl bg-hl-panel p-4 text-body text-white">
          No alerts match this filter.
        </p>
      ) : null}

      {visible.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {visible.map((event) => (
            <li key={event.event_id}>
              <AlertRow
                event={event}
                distanceM={distanceFrom(event, userPoint)}
                now={now}
                onSelect={() => select({ kind: "event", id: event.event_id })}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function metaLine(event: CanonicalEvent, distanceM: number, now: Date, direction?: string): string {
  return [
    CONFIDENCE_TEXT[event.confidence_label],
    eventTypeLabel(event.event_type),
    Number.isFinite(distanceM) ? `${formatDistance(distanceM)}${direction ? ` ${direction}` : ""}` : null,
    formatAge(event.last_verified_at, now),
  ]
    .filter(Boolean)
    .join(" · ");
}

function AlertRow({
  event,
  distanceM,
  now,
  onSelect,
}: {
  event: CanonicalEvent;
  distanceM: number;
  now: Date;
  onSelect: () => void;
}) {
  const tone = SEVERITY_TONE[event.severity];
  const stale = isStale(event.last_verified_at, eventMaxAge(event.event_type), now);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full gap-3 rounded-2xl bg-hl-panel p-4 text-left transition-colors hover:bg-hl-raised"
    >
      <span aria-hidden="true" className={["w-1 shrink-0 rounded-full", TONE_BAR_CLASS[tone]].join(" ")} />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-body font-medium text-white">{event.headline}</span>
        <span className="text-meta">
          <span className={TONE_TEXT_CLASS[tone]}>{SEVERITY_WORD[event.severity]}</span>
          <span className="text-hl-muted"> · {metaLine(event, distanceM, now)}</span>
        </span>
        {event.status !== "active" ? (
          <span className="text-meta text-hl-muted">No longer active ({event.status})</span>
        ) : null}
        {stale ? <span className="text-meta text-hl-moderate">Not re-verified recently</span> : null}
      </span>
    </button>
  );
}

function AlertDetail({
  eventId,
  fallback,
  user,
  now,
  onBack,
  onShowOnMap,
  onAsk,
}: {
  eventId: string;
  fallback: CanonicalEvent | null;
  user: LonLat;
  now: Date;
  onBack: () => void;
  onShowOnMap: () => void;
  onAsk: (headline: string) => void;
}) {
  const detail = useQuery({
    queryKey: ["event", eventId],
    queryFn: ({ signal }) => fetchEvent(eventId, signal),
    staleTime: 30_000,
    retry: 1,
  });
  const event = detail.data?.event ?? fallback;
  const sources = detail.data?.source_records ?? [];
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [eventId]);

  return (
    <article className="flex flex-col gap-3" aria-labelledby="alert-detail-heading">
      <div>
        <Button variant="quiet" className="-ml-2 px-2" onClick={onBack}>
          ← All alerts
        </Button>
      </div>

      {!event ? (
        <p className="rounded-2xl bg-hl-panel p-4 text-body text-white">
          {detail.isPending ? "Loading alert…" : "This alert could not be loaded."}
        </p>
      ) : (
        <div className="flex flex-col gap-3 rounded-2xl bg-hl-panel p-4">
          <p className="text-meta">
            <span className={TONE_TEXT_CLASS[SEVERITY_TONE[event.severity]]}>
              {SEVERITY_WORD[event.severity]}
            </span>
            <span className="text-hl-muted">
              {" · "}
              {(() => {
                const c = centroidOf(event);
                return metaLine(event, distanceFrom(event, user), now, c ? compassDirection(user, c) : undefined);
              })()}
            </span>
          </p>
          <h2
            id="alert-detail-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-value font-semibold text-white"
          >
            {event.headline}
          </h2>
          {event.instructions ? (
            <div className="rounded-xl bg-hl-teal-soft p-3">
              <p className="text-meta font-medium text-hl-action">What to do</p>
              <p className="mt-1 text-body text-white">{event.instructions}</p>
            </div>
          ) : null}
          <p className="text-body whitespace-pre-line text-white">{event.description}</p>
          {event.contradiction_note ? (
            <p className="rounded-xl bg-hl-amber-soft p-3 text-meta text-white">
              <span className="font-medium text-hl-moderate">Reports disagree. </span>
              {event.contradiction_note}
            </p>
          ) : null}

          <div className="flex flex-col gap-1">
            <h3 className="text-meta font-medium text-hl-muted">
              Sources ({event.source_count})
            </h3>
            {sources.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {sources.map((s) => (
                  <li key={s.source_record_id} className="text-meta text-white">
                    {s.source_url ? (
                      <a href={s.source_url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                        {s.provider}
                      </a>
                    ) : (
                      s.provider
                    )}
                    <span className="text-hl-muted">
                      {" "}
                      · tier {s.provider_tier} · published {formatAge(s.published_at, now)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <SourceLine>
                {detail.isPending
                  ? "Loading sources…"
                  : `Best source tier ${event.best_tier} · verified ${formatAge(event.last_verified_at, now)}`}
              </SourceLine>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={onShowOnMap}>
              Show on map
            </Button>
            <Button onClick={() => onAsk(event.headline)}>Ask about this</Button>
          </div>
        </div>
      )}
    </article>
  );
}
