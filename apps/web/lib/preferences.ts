/**
 * Settings the person chooses, stored on this device only (`localStorage`).
 *
 * Collected: where "me" is, and access needs that change a result. Not
 * collected: name, age, gender or free-text health details.
 */

export const PREFERENCES_KEY = "hl.prefs.v1";

/** "device" asks the browser; "manual" is a point picked on the map; "demo" is the region centre. */
export type LocationMode = "device" | "manual" | "demo";

export type AccessNeed =
  | "step_free"
  | "accessible_restroom"
  | "limited_walking"
  | "medical_power"
  | "pets";

export const ACCESS_NEEDS: { id: AccessNeed; label: string; effect: string }[] = [
  {
    id: "step_free",
    label: "I use a wheelchair or need step-free access",
    effect: "Shelters that list accessibility features rank first.",
  },
  {
    id: "accessible_restroom",
    label: "I need an accessible restroom",
    effect: "Shelters that list an accessible restroom rank first.",
  },
  {
    id: "limited_walking",
    label: "I can only walk a short distance",
    effect: "The nearest shelter ranks first on Now, even when a further one fits better. Not sent.",
  },
  {
    id: "medical_power",
    label: "I need power for medical equipment",
    effect: "Charging points list first on Now. Not sent.",
  },
  {
    id: "pets",
    label: "I am travelling with pets",
    effect: "Shelters that accept pets rank first.",
  },
];

/**
 * The needs the assistant API accepts (`access_needs`), and the setting each
 * one comes from. The other settings act on this device only.
 */
const SERVER_NEED: Partial<Record<AccessNeed, string>> = {
  step_free: "wheelchair",
  accessible_restroom: "accessible_restroom",
  pets: "pets",
};

export function serverAccessNeeds(needs: AccessNeed[]): string[] {
  return [...new Set(needs.map((n) => SERVER_NEED[n]).filter((n): n is string => Boolean(n)))];
}

export interface ManualPoint {
  lon: number;
  lat: number;
  label: string;
}

export interface Preferences {
  version: 1;
  locationMode: LocationMode;
  manual: ManualPoint | null;
  needs: AccessNeed[];
  largeText: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  locationMode: "device",
  manual: null,
  needs: [],
  largeText: false,
};

const NEED_IDS = new Set<string>(ACCESS_NEEDS.map((n) => n.id));

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate a stored value. Anything malformed falls back to the defaults. */
export function parsePreferences(raw: unknown): Preferences {
  if (!raw || typeof raw !== "object") return DEFAULT_PREFERENCES;
  const o = raw as Record<string, unknown>;
  if (o["version"] !== 1) return DEFAULT_PREFERENCES;

  const mode = o["locationMode"];
  const locationMode: LocationMode =
    mode === "device" || mode === "manual" || mode === "demo" ? mode : "device";

  let manual: ManualPoint | null = null;
  const m = o["manual"];
  if (m && typeof m === "object") {
    const p = m as Record<string, unknown>;
    if (
      isFiniteNumber(p["lon"]) &&
      isFiniteNumber(p["lat"]) &&
      Math.abs(p["lon"]) <= 180 &&
      Math.abs(p["lat"]) <= 90
    ) {
      manual = {
        lon: p["lon"],
        lat: p["lat"],
        label: typeof p["label"] === "string" ? p["label"].slice(0, 80) : "Picked on the map",
      };
    }
  }

  const needs = Array.isArray(o["needs"])
    ? (o["needs"].filter((n) => typeof n === "string" && NEED_IDS.has(n)) as AccessNeed[])
    : [];

  return {
    version: 1,
    locationMode: locationMode === "manual" && !manual ? "device" : locationMode,
    manual,
    needs: [...new Set(needs)],
    largeText: o["largeText"] === true,
  };
}

export function loadPreferences(): Preferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const stored = window.localStorage.getItem(PREFERENCES_KEY);
    return stored ? parsePreferences(JSON.parse(stored)) : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: Preferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Storage full or blocked: the setting still applies for this visit.
  }
}
