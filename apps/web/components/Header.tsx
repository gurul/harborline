"use client";

import { SEVERITY_RANK, type CanonicalEvent } from "@harborline/event-schema";
import { useAppState } from "./AppState";
import { useLiveFeed } from "../lib/useLiveFeed";

/** Small pixel-cluster glyph — the wordmark's only ornament. */
function HarborlineGlyph() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 22 22"
      role="img"
      aria-label="Harborline mark"
      className="shrink-0"
    >
      <rect x="2" y="9" width="4" height="4" rx="1" fill="#14b8a6" />
      <rect x="9" y="2" width="4" height="4" rx="1" fill="#f5a524" />
      <rect x="9" y="9" width="4" height="4" rx="1" fill="#ffffff" />
      <rect x="9" y="16" width="4" height="4" rx="1" fill="#3f3f4a" />
      <rect x="16" y="9" width="4" height="4" rx="1" fill="#ef4444" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-3">
      <HarborlineGlyph />
      <span className="text-[0.95rem] font-semibold tracking-[0.34em] text-white select-none">
        HARBORLINE
      </span>
    </div>
  );
}

export interface StatusPillProps {
  events: CanonicalEvent[];
}

/**
 * The pill restates the highest active severity in the loaded record set. It
 * makes no independent judgement — no records, no elevated claim.
 */
export function StatusPill({ events }: StatusPillProps) {
  const active = events.filter((event) => event.status === "active");
  const peak = active.reduce<number>(
    (max, event) => Math.max(max, SEVERITY_RANK[event.severity]),
    0,
  );
  const elevated = peak >= SEVERITY_RANK.severe;

  return (
    <span
      role="status"
      aria-live="polite"
      className={[
        "inline-flex min-h-9 items-center gap-2 rounded-full border px-4 py-1.5 text-xs font-medium",
        elevated
          ? "border-hl-amber/40 bg-hl-amber-soft text-hl-amber"
          : "border-hl-line bg-hl-raised text-hl-muted",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "h-2 w-2 rounded-full",
          elevated ? "bg-hl-amber" : "bg-hl-dim",
        ].join(" ")}
      />
      {elevated ? "Status: Elevated risk" : "Status: Monitoring"}
    </span>
  );
}

export function Header() {
  const { user } = useAppState();
  const { events, streamConnected, isLoading } = useLiveFeed({
    lat: user.lat,
    lon: user.lon,
  });

  return (
    <header
      aria-label="Harborline header"
      className="sticky top-0 z-30 border-b border-hl-line/70 bg-hl-bg/85 backdrop-blur-md"
    >
      <div className="mx-auto flex w-full max-w-[1800px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Wordmark />

        <div className="flex items-center gap-2 sm:gap-3">
          <span
            className="hidden items-center gap-2 text-[11px] text-hl-dim sm:inline-flex"
            title={
              streamConnected
                ? "Live stream connected"
                : "Live stream reconnecting — showing last fetched records"
            }
          >
            <span
              aria-hidden="true"
              className={[
                "h-1.5 w-1.5 rounded-full",
                streamConnected ? "bg-hl-teal" : "bg-hl-dim",
              ].join(" ")}
            />
            {isLoading ? "Loading" : streamConnected ? "Live" : "Reconnecting"}
          </span>
          <StatusPill events={events} />
        </div>
      </div>
    </header>
  );
}

export default Header;
