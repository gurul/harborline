"use client";

import { useRef, type KeyboardEvent } from "react";
import { eventMaxAge, isStale } from "@harborline/event-schema";
import { useNow } from "../lib/format";
import { useLiveFeed } from "../lib/useLiveFeed";
import { useIsDesktop } from "../lib/useMediaQuery";
import { AlertsView } from "./AlertsView";
import { useAppState, type View } from "./AppState";
import { AskView } from "./AskView";
import { BottomNav } from "./BottomNav";
import { MapPanel } from "./MapPanel";
import { NowView } from "./NowView";
import { SettingsSheet } from "./SettingsSheet";
import { SituationBanner } from "./SituationBanner";
import { TopBar } from "./TopBar";

type RailView = Exclude<View, "map">;
const RAIL_VIEWS: { view: RailView; label: string }[] = [
  { view: "now", label: "Now" },
  { view: "alerts", label: "Alerts" },
  { view: "ask", label: "Ask" },
];

/**
 * Desktop (1024 px and wider): the map plus one switchable side panel.
 * Phone: one region at a time, chosen from the bottom bar.
 */
export function AppShell() {
  const { user, view, setView } = useAppState();
  const isDesktop = useIsDesktop();
  const feed = useLiveFeed({ lat: user.lat, lon: user.lon });
  const now = useNow(60_000);
  const tabRefs = useRef<Record<RailView, HTMLButtonElement | null>>({ now: null, alerts: null, ask: null });

  const railView: RailView = view === "map" ? "now" : view;
  const mapOnly = !isDesktop && view === "map";
  const activeAlerts = feed.events.filter(
    (e) => e.status === "active" && !isStale(e.last_verified_at, eventMaxAge(e.event_type), now),
  ).length;

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    let nextIndex = index + delta;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = RAIL_VIEWS.length - 1;
    if (nextIndex === index) return;
    event.preventDefault();
    const next = RAIL_VIEWS[(nextIndex + RAIL_VIEWS.length) % RAIL_VIEWS.length];
    if (!next) return;
    setView(next.view);
    tabRefs.current[next.view]?.focus();
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-hl-bg">
      <a
        href={mapOnly ? "#map-region" : "#view-region"}
        className="sr-only z-50 rounded-xl bg-white px-4 py-3 text-meta font-medium text-hl-bg focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to current view
      </a>
      <h1 className="sr-only">Harborline: situation near {user.label}</h1>

      <TopBar />
      <SituationBanner />

      <main className="relative grid min-h-0 flex-1 grid-cols-1 grid-rows-1 lg:grid-cols-[400px_minmax(0,1fr)]">
        <div
          className={[
            "min-h-0 flex-col bg-hl-surface lg:flex lg:border-r lg:border-hl-line",
            mapOnly ? "hidden" : "flex",
          ].join(" ")}
        >
          {isDesktop ? (
            <div role="tablist" aria-label="Side panel" className="flex shrink-0 gap-1 border-b border-hl-line p-2">
              {RAIL_VIEWS.map((item, index) => {
                const selected = railView === item.view;
                return (
                  <button
                    key={item.view}
                    ref={(el) => {
                      tabRefs.current[item.view] = el;
                    }}
                    id={`tab-${item.view}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`panel-${item.view}`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setView(item.view)}
                    onKeyDown={(e) => onTabKey(e, index)}
                    className={[
                      "inline-flex min-h-11 flex-1 items-center justify-center rounded-xl text-meta font-medium transition-colors",
                      selected ? "bg-hl-raised text-white" : "text-hl-muted hover:text-white",
                    ].join(" ")}
                  >
                    {item.label}
                    {item.view === "alerts" && activeAlerts > 0 ? ` ${activeAlerts}` : ""}
                  </button>
                );
              })}
            </div>
          ) : null}

          <div id="view-region" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 focus:outline-none">
            {RAIL_VIEWS.map((item) => (
              <div
                key={item.view}
                id={`panel-${item.view}`}
                role={isDesktop ? "tabpanel" : "region"}
                aria-labelledby={isDesktop ? `tab-${item.view}` : undefined}
                aria-label={isDesktop ? undefined : item.label}
                hidden={railView !== item.view}
                className={item.view === "ask" ? "min-h-full" : "pb-6"}
              >
                {item.view === "now" ? <NowView /> : null}
                {item.view === "alerts" ? <AlertsView /> : null}
                {item.view === "ask" ? <AskView active={railView === "ask" && !mapOnly} /> : null}
              </div>
            ))}
          </div>
        </div>

        <div
          id="map-region"
          tabIndex={-1}
          className={["min-h-0 focus:outline-none lg:block", mapOnly ? "block" : "hidden"].join(" ")}
        >
          <MapPanel />
        </div>
      </main>

      <BottomNav view={view} onChange={setView} alertCount={activeAlerts} />
      <SettingsSheet />
    </div>
  );
}
