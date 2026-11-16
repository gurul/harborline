"use client";

import { formatDuration, humanizeRejection } from "../lib/format";
import type { RouteState } from "./AppState";

/** The route summary over the map: destination, outcome, rejected routes, Clear. */
export function RouteBar({ route, onClear }: { route: RouteState; onClear: () => void }) {
  if (route.status === "idle") return null;
  const name = route.destination.name;

  let title: string;
  let body: string | null = null;
  let tone = "text-white";
  let rejected: { id: string; reason: string }[] = [];

  switch (route.status) {
    case "loading":
      title = `Finding a route to ${name}…`;
      break;
    case "ready": {
      const rec = route.routes.recommendation;
      title = rec
        ? `${formatDuration(rec.duration_min)} to ${name}, avoids ${rec.avoided_hazard_count} ${rec.avoided_hazard_count === 1 ? "hazard" : "hazards"}`
        : `Route to ${name}`;
      body = rec?.summary ?? null;
      rejected = route.routes.candidates
        .filter((c) => c.eliminated)
        .map((c) => ({ id: c.route_id, reason: humanizeRejection(c.rejected_reason) ?? "rejected" }));
      break;
    }
    case "no_route":
      title = `No verified route to ${name}`;
      body = route.message;
      tone = "text-hl-moderate";
      rejected = route.candidates
        .filter((c) => c.eliminated)
        .map((c) => ({ id: c.route_id, reason: humanizeRejection(c.rejected_reason) ?? "rejected" }));
      break;
    case "unavailable":
      title = `${name} cannot be recommended now`;
      body = [humanizeRejection(route.reason), route.message].filter(Boolean).join(". ");
      tone = "text-hl-moderate";
      break;
    case "error":
      title = `Routing to ${name} failed`;
      body = route.message;
      tone = "text-hl-moderate";
      break;
  }

  return (
    <section
      aria-label="Route"
      aria-live="polite"
      className="pointer-events-auto flex flex-col gap-1 rounded-2xl bg-hl-panel p-4 shadow-2xl"
    >
      <div className="flex items-start justify-between gap-3">
        <p className={["text-body font-medium", tone].join(" ")}>{title}</p>
        <button
          type="button"
          onClick={onClear}
          className="-my-2 inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 text-meta font-medium text-white underline underline-offset-4 hover:bg-hl-raised"
        >
          Clear route
        </button>
      </div>
      {body ? (
        <p className={["text-meta text-white", route.status === "ready" ? "hidden lg:block" : ""].join(" ")}>
          {body}
        </p>
      ) : null}
      {rejected.length > 0 ? (
        <details className="text-meta text-hl-muted">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-white">
            {rejected.length} {rejected.length === 1 ? "route" : "routes"} rejected
          </summary>
          <ul className="flex flex-col gap-1 pb-1">
            {rejected.map((r) => (
              <li key={r.id}>A route {r.reason}.</li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="text-meta text-hl-muted">
        Demonstration routing. Re-check conditions before you leave.
      </p>
    </section>
  );
}
