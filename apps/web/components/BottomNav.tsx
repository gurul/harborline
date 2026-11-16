"use client";

import type { ReactNode } from "react";
import type { View } from "./AppState";

const ICON: Record<View, ReactNode> = {
  now: <path d="M12 3 3 10v11h6v-6h6v6h6V10z" />,
  map: <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zm0 2v12m6-10v12" />,
  alerts: <path d="M12 3 2 20h20L12 3zm0 6v5m0 3v.5" />,
  ask: <path d="M4 5h16v11H9l-5 4z" />,
};

const ITEMS: { view: View; label: string }[] = [
  { view: "now", label: "Now" },
  { view: "map", label: "Map" },
  { view: "alerts", label: "Alerts" },
  { view: "ask", label: "Ask" },
];

/** Phone navigation: one destination per button. */
export function BottomNav({
  view,
  onChange,
  alertCount,
}: {
  view: View;
  onChange: (view: View) => void;
  alertCount: number;
}) {
  return (
    <nav
      aria-label="Views"
      className="shrink-0 border-t border-hl-line bg-hl-bg pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="grid grid-cols-4">
        {ITEMS.map((item) => {
          const active = view === item.view;
          return (
            <li key={item.view}>
              <button
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => onChange(item.view)}
                className={[
                  "flex min-h-16 w-full flex-col items-center justify-center gap-1 text-label font-medium",
                  active ? "text-white" : "text-hl-muted hover:text-white",
                ].join(" ")}
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                >
                  {ICON[item.view]}
                </svg>
                <span>
                  {item.label}
                  {item.view === "alerts" && alertCount > 0 ? (
                    <span>
                      {" "}
                      {alertCount}
                      <span className="sr-only"> active</span>
                    </span>
                  ) : null}
                </span>
                <span
                  aria-hidden="true"
                  className={["h-0.5 w-6 rounded-full", active ? "bg-white" : "bg-transparent"].join(" ")}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
