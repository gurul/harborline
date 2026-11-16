"use client";

import { useSyncExternalStore } from "react";
import { formatAge, formatClock, useNow } from "../lib/format";
import { useSourceHealth } from "../lib/queries";
import { useLiveFeed } from "../lib/useLiveFeed";
import { useAppState } from "./AppState";

/** Small pixel-cluster glyph: the wordmark's only ornament. */
function HarborlineGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" className="shrink-0">
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
      <span className="hidden text-meta font-semibold tracking-[0.34em] text-white select-none sm:inline">
        HARBORLINE
      </span>
    </div>
  );
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

/**
 * One line of connection truth. It never says "live" or "monitoring" when
 * the service cannot be reached.
 */
export function ConnectionStatus() {
  const { user } = useAppState();
  const feed = useLiveFeed({ lat: user.lat, lon: user.lon });
  const health = useSourceHealth();
  const online = useOnline();
  const now = useNow(30_000);

  const since = feed.updatedAt ? formatAge(new Date(feed.updatedAt).toISOString(), now) : null;
  const failing = (health.data?.sources ?? []).filter(
    (s) => s.circuit_open || !s.healthy,
  ).length;

  let dot = "bg-hl-control-edge";
  let text: string;
  let textClass = "text-hl-muted";
  if (!online) {
    dot = "bg-hl-amber";
    textClass = "text-hl-moderate";
    text = feed.updatedAt ? `Offline · data from ${formatClock(feed.updatedAt)}` : "Offline";
  } else if (feed.isLoading) {
    text = "Connecting…";
  } else if (feed.isError) {
    dot = "bg-hl-red";
    textClass = "text-hl-severe";
    text = feed.hasData
      ? `Cannot reach Harborline · data from ${formatClock(feed.updatedAt)}`
      : "Cannot reach Harborline";
  } else if (feed.streamConnected) {
    dot = "bg-hl-green";
    textClass = "text-white";
    text = `Live · updated ${since ?? "now"}`;
  } else {
    dot = "bg-hl-amber";
    textClass = "text-white";
    text = `Reconnecting · updated ${since ?? "unknown"}`;
  }

  return (
    <p role="status" className={["flex min-w-0 items-center gap-2 text-meta", textClass].join(" ")}>
      <span aria-hidden="true" className={["h-2 w-2 shrink-0 rounded-full", dot].join(" ")} />
      <span className="truncate">
        {text}
        {failing > 0 && online && !feed.isError ? (
          <span className="text-hl-moderate">
            {" "}
            · {failing} {failing === 1 ? "source" : "sources"} quiet
          </span>
        ) : null}
      </span>
    </p>
  );
}

export function TopBar() {
  const { user, openSettings } = useAppState();
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-hl-line bg-hl-bg px-3 lg:px-4">
      <Wordmark />
      <ConnectionStatus />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => openSettings("location")}
          className="inline-flex min-h-11 max-w-[8.5rem] items-center gap-2 rounded-xl border border-hl-control-edge px-3 text-meta text-white hover:bg-hl-raised sm:max-w-xs"
        >
          <span className="sr-only">Location: </span>
          <span className="truncate">
            {user.label}
            {user.approximate ? <span className="hidden sm:inline"> (approx.)</span> : null}
          </span>
          <span className="sr-only">. Change location.</span>
        </button>
        <button
          type="button"
          onClick={() => openSettings("needs")}
          aria-label="Settings: location and access needs"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-hl-control-edge text-meta text-white hover:bg-hl-raised sm:px-3"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" className="sm:hidden">
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" strokeLinecap="round" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="10" cy="17" r="2" />
          </svg>
          <span className="hidden sm:inline">Settings</span>
        </button>
      </div>
    </header>
  );
}
