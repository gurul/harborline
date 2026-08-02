"use client";

import { useEffect, useState } from "react";
import {
  formatAge,
  type ConfidenceLabel,
  type EventType,
  type OperationalStatus,
  type Severity,
  type SourceTier,
} from "@harborline/event-schema";

// The canonical age formatter lives in the schema package — re-exported so UI
// code has exactly one source of truth for "how old is this record".
export { formatAge };

/** "Updated 8 min ago" — the freshness stamp that accompanies every claim. */
export function formatUpdated(lastVerifiedAt: string, now: Date): string {
  const age = formatAge(lastVerifiedAt, now);
  return age === "just now" ? "Updated just now" : `Updated ${age}`;
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "—";
  if (meters < 950) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(meters < 9500 ? 1 : 0)} km`;
}

export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** A clock that ticks so relative ages stay honest without a full refetch. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

// --- Presentation vocabulary ------------------------------------------------

export const CONFIDENCE_TEXT: Record<ConfidenceLabel, string> = {
  official: "Official",
  verified: "Verified",
  developing: "Developing",
  unverified: "Unverified",
};

export const CONFIDENCE_CLASS: Record<ConfidenceLabel, string> = {
  official: "bg-hl-blue-soft text-hl-blue border-hl-blue/40",
  verified: "bg-hl-green-soft text-hl-green border-hl-green/40",
  developing: "bg-hl-amber-soft text-hl-amber border-hl-amber/40",
  unverified: "bg-hl-raised text-hl-muted border-hl-line",
};

export const SEVERITY_COLOR: Record<Severity, string> = {
  extreme: "#dc2626",
  severe: "#ef4444",
  moderate: "#f5a524",
  minor: "#fbbf24",
};

export const SEVERITY_TEXT_CLASS: Record<Severity, string> = {
  extreme: "text-hl-red",
  severe: "text-hl-red",
  moderate: "text-hl-amber",
  minor: "text-hl-amber",
};

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  flood: "Flood",
  road_closure: "Road closure",
  power_outage: "Power outage",
  earthquake: "Earthquake",
  fire: "Fire",
  landslide: "Landslide",
  shelter_open: "Shelter open",
  shelter_full: "Shelter full",
  transit_disruption: "Transit",
  evacuation_order: "Evacuation order",
  weather_warning: "Weather warning",
};

export const RESOURCE_STATUS_TEXT: Record<OperationalStatus, string> = {
  open: "Open",
  closed: "Closed",
  full: "Full",
  unknown: "Status unknown",
};

export const RESOURCE_STATUS_COLOR: Record<OperationalStatus, string> = {
  open: "#22c55e",
  closed: "#6b7280",
  full: "#f5a524",
  unknown: "#6b7280",
};

export function tierLabel(tier: SourceTier): string {
  return `Tier ${tier}`;
}

/** Rejection reasons come back from the router as machine slugs. */
export const REJECTED_REASON_TEXT: Record<string, string> = {
  closure_intersection: "crosses a reported road closure",
  evacuation_zone: "enters an active evacuation zone",
  no_path: "no connected path in the demonstration graph",
  stale_status: "status not re-verified inside its freshness window",
};

export function humanizeRejection(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REJECTED_REASON_TEXT[reason] ?? reason.replace(/_/g, " ");
}
