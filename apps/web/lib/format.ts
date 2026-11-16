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
  extreme: "#ef4444",
  severe: "#ef4444",
  moderate: "#f5a524",
  minor: "#fbbf24",
};

export const SEVERITY_TEXT_CLASS: Record<Severity, string> = {
  extreme: "text-hl-extreme",
  severe: "text-hl-severe",
  moderate: "text-hl-moderate",
  minor: "text-hl-minor",
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
  fire_detection: "Satellite heat detection",
  fire_perimeter: "Wildfire perimeter",
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
  hazard_zone: "crosses a severe fire, flood or landslide area",
  no_path: "no connected path in the demonstration graph",
  stale_status: "status not re-verified inside its freshness window",
  inside_hazard_zone: "inside an active hazard area",
};

export function humanizeRejection(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REJECTED_REASON_TEXT[reason] ?? reason.replace(/_/g, " ");
}

// --- Tones: the only colour on data -----------------------------------------

/**
 * Colour roles. Severity tones colour hazards; `ok` marks an open place or a
 * good reading; `action` marks the recommended action and the route; `info`
 * marks an official source. `neutral` is every unknown, stale or missing value.
 */
export type Tone =
  | "extreme"
  | "severe"
  | "moderate"
  | "minor"
  | "ok"
  | "neutral"
  | "action"
  | "info";

export const TONE_TEXT_CLASS: Record<Tone, string> = {
  extreme: "text-hl-extreme",
  severe: "text-hl-severe",
  moderate: "text-hl-moderate",
  minor: "text-hl-minor",
  ok: "text-hl-ok",
  neutral: "text-hl-muted",
  action: "text-hl-action",
  info: "text-hl-info",
};

/** Solid colour for a severity bar or dot. */
export const TONE_BAR_CLASS: Record<Tone, string> = {
  extreme: "bg-hl-red",
  severe: "bg-hl-red",
  moderate: "bg-hl-amber",
  minor: "bg-hl-minor",
  ok: "bg-hl-green",
  neutral: "bg-hl-control-edge",
  action: "bg-hl-teal",
  info: "bg-hl-blue",
};

export const SEVERITY_TONE: Record<Severity, Tone> = {
  extreme: "extreme",
  severe: "severe",
  moderate: "moderate",
  minor: "minor",
};

export const SEVERITY_WORD: Record<Severity, string> = {
  extreme: "Extreme",
  severe: "Severe",
  moderate: "Moderate",
  minor: "Minor",
};

/** Event type label with a readable fallback for types newer than this build. */
export function eventTypeLabel(type: string): string {
  const known = (EVENT_TYPE_LABEL as Record<string, string | undefined>)[type];
  if (known) return known;
  const words = type.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Accessibility slugs from resource feeds, in words. */
export const FEATURE_TEXT: Record<string, string> = {
  wheelchair_accessible: "Wheelchair access",
  accessible_restrooms: "Accessible restrooms",
  step_free: "Step-free entrance",
  step_free_access: "Step-free entrance",
  accessible_parking: "Accessible parking",
  medical_power: "Power for medical equipment",
  backup_power: "Backup power",
  service_animals: "Service animals allowed",
  hearing_loop: "Hearing loop",
  asl_interpretation: "Sign-language interpretation",
};

export function featureText(slug: string): string {
  const known = FEATURE_TEXT[slug];
  if (known) return known;
  const words = slug.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Local clock time, "14:02". */
export function formatClock(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** Compass direction from `from` to `to`, both [lon, lat]. */
export function compassDirection(from: [number, number], to: [number, number]): string {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lon1, lat1] = from;
  const [lon2, lat2] = to;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(bearing / 45) % 8] ?? "nearby";
}

/** First sentence of a block of text, for one-line summaries. */
export function firstSentence(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const match = /^(.+?[.!?])(\s|$)/.exec(trimmed);
  return (match?.[1] ?? trimmed).slice(0, 220);
}

/** Source line for one record: "Official · tier A · 5 min ago". */
export function provenanceLine(
  parts: { provider?: string | null; tier?: string | null; at?: string | null; ageLabel?: string | null },
  now: Date,
): string {
  const out: string[] = [];
  if (parts.provider) out.push(parts.provider);
  if (parts.tier) out.push(`tier ${parts.tier}`);
  if (parts.at) out.push(formatAge(parts.at, now));
  else if (parts.ageLabel) out.push(parts.ageLabel);
  else out.push("age not reported");
  return out.join(" · ");
}
