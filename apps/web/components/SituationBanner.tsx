"use client";

import { useMemo } from "react";
import {
  SEVERITY_RANK,
  eventMaxAge,
  geometryCentroid,
  haversineMeters,
  isStale,
  type CanonicalEvent,
  type LonLat,
  type Urgency,
} from "@harborline/event-schema";
import {
  CONFIDENCE_TEXT,
  SEVERITY_WORD,
  compassDirection,
  eventTypeLabel,
  firstSentence,
  formatAge,
  formatClock,
  formatDistance,
  useNow,
} from "../lib/format";
import { useLiveFeed } from "../lib/useLiveFeed";
import { useAppState } from "./AppState";

const URGENCY_RANK: Record<Urgency, number> = {
  immediate: 4,
  expected: 3,
  future: 2,
  unknown: 1,
  past: 0,
};

function centroid(event: CanonicalEvent): LonLat | null {
  try {
    return geometryCentroid(event.geometry);
  } catch {
    return null;
  }
}

/** The single most important active alert: severity, then urgency, then distance. */
function topAlert(events: CanonicalEvent[], user: LonLat, now: Date) {
  let best: { event: CanonicalEvent; distance: number; centre: LonLat | null } | null = null;
  for (const event of events) {
    if (event.status !== "active") continue;
    if (isStale(event.last_verified_at, eventMaxAge(event.event_type), now)) continue;
    const centre = centroid(event);
    const distance = centre ? haversineMeters(user, centre) : Number.POSITIVE_INFINITY;
    if (!best) {
      best = { event, distance, centre };
      continue;
    }
    const bySeverity = SEVERITY_RANK[event.severity] - SEVERITY_RANK[best.event.severity];
    const byUrgency = URGENCY_RANK[event.urgency] - URGENCY_RANK[best.event.urgency];
    if (bySeverity > 0 || (bySeverity === 0 && (byUrgency > 0 || (byUrgency === 0 && distance < best.distance)))) {
      best = { event, distance, centre };
    }
  }
  return best;
}

export function SituationBanner() {
  const { user, select, setView, ask } = useAppState();
  const feed = useLiveFeed({ lat: user.lat, lon: user.lon });
  const now = useNow(30_000);
  const userPoint = useMemo<LonLat>(() => [user.lon, user.lat], [user.lon, user.lat]);
  const top = useMemo(() => topAlert(feed.events, userPoint, now), [feed.events, userPoint, now]);

  if (feed.isLoading) return null;

  if (feed.isError) {
    return (
      <section
        aria-label="Connection problem"
        role="alert"
        className="shrink-0 bg-hl-red-soft px-4 py-3 text-body text-white"
      >
        <span className="font-semibold text-hl-severe">Cannot reach Harborline. </span>
        {feed.hasData
          ? `Showing data from ${formatClock(feed.updatedAt)}. `
          : "No alerts can be shown. "}
        Do not read this as all-clear.
      </section>
    );
  }

  if (!top) return null;
  const { event, distance, centre } = top;
  const alarm = SEVERITY_RANK[event.severity] >= SEVERITY_RANK.severe;
  const where = Number.isFinite(distance)
    ? `${formatDistance(distance)} ${centre ? compassDirection(userPoint, centre) : ""}`.trim()
    : null;
  const guidance = firstSentence(event.instructions) ?? firstSentence(event.description);

  const openDetail = () => {
    select({ kind: "event", id: event.event_id });
    setView("alerts");
  };

  return (
    <section
      aria-labelledby="banner-headline"
      className={[
        "flex shrink-0 flex-col gap-2 px-3 py-2 lg:flex-row lg:items-center lg:gap-6 lg:px-4 lg:py-3",
        alarm ? "bg-hl-alarm text-white" : "bg-hl-amber-soft text-white",
      ].join(" ")}
    >
      <div className="min-w-0 flex-1">
        <p className="text-meta font-medium">
          <span className={alarm ? "" : "text-hl-moderate"}>{SEVERITY_WORD[event.severity]}</span>
          {" · "}
          {eventTypeLabel(event.event_type)}
          {where ? ` · ${where}` : ""}
          {/* Phone: source and age share the first line. */}
          <span className="lg:hidden">
            {" · "}
            {CONFIDENCE_TEXT[event.confidence_label]} · {formatAge(event.last_verified_at, now)}
          </span>
        </p>
        <h2 id="banner-headline" className="line-clamp-2 text-body font-semibold lg:line-clamp-none lg:text-value">
          {event.headline}
        </h2>
        {guidance ? <p className="hidden text-meta lg:block">{guidance}</p> : null}
        <p className="hidden text-meta lg:block">
          {CONFIDENCE_TEXT[event.confidence_label]} · tier {event.best_tier} ·{" "}
          {formatAge(event.last_verified_at, now)}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={() => ask("What should I do right now?")}
          className="inline-flex min-h-11 items-center rounded-xl bg-white px-4 text-meta font-medium text-hl-bg hover:bg-white/90"
        >
          What should I do?
        </button>
        <button
          type="button"
          onClick={openDetail}
          className="inline-flex min-h-11 items-center rounded-xl border border-white/80 px-4 text-meta font-medium text-white hover:bg-white/10"
        >
          Read alert
        </button>
      </div>
    </section>
  );
}
