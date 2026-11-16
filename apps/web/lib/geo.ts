"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { REGION, type LonLat } from "@harborline/event-schema";

/** Region centre: the demo default, and the fallback when no fix exists. */
export const FALLBACK_LOCATION: LonLat = REGION.center;

/** Label for the demo default, e.g. "Chico centre". */
export const FALLBACK_LABEL = REGION.centerLabel;

export type LocationSource = "device" | "manual" | "demo";

export interface UserLocation {
  lon: number;
  lat: number;
  /** True when the point is a guess (region centre), not a fix or a choice. */
  approximate: boolean;
  source: LocationSource;
  /** Short place label for the location chip. */
  label: string;
  /** Why a device fix is missing, when it is. */
  error: string | null;
}

export type DeviceFix =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "ok"; lon: number; lat: number; accuracyM: number | null }
  | { status: "error"; message: string };

/**
 * Browser geolocation. Asks only while `enabled`, and again on `retry()`.
 * A denied or failed request is reported, never hidden.
 */
export function useDeviceLocation(enabled: boolean): DeviceFix & { retry: () => void } {
  const [fix, setFix] = useState<DeviceFix>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setFix({ status: "error", message: "This browser cannot share a location." });
      return;
    }
    let cancelled = false;
    setFix((previous) => (previous.status === "ok" ? previous : { status: "pending" }));
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (cancelled) return;
        setFix({
          status: "ok",
          lon: position.coords.longitude,
          lat: position.coords.latitude,
          accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
        });
      },
      (err) => {
        if (cancelled) return;
        const message =
          err.code === err.PERMISSION_DENIED
            ? "Location permission is off for this site."
            : err.code === err.TIMEOUT
              ? "The device did not return a location in time."
              : "The device location is unavailable.";
        setFix({ status: "error", message });
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 60_000 },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return useMemo(() => ({ ...fix, retry }), [fix, retry]);
}

export function toLonLat(location: { lon: number; lat: number }): LonLat {
  return [location.lon, location.lat];
}

/** "39.7285, -121.8375": used only when no place name exists. */
export function formatCoordinates(lon: number, lat: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}
