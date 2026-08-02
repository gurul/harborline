"use client";

import { useEffect, useState } from "react";
import { SEATTLE_CENTER, type LonLat } from "@harborline/event-schema";

/** Downtown Seattle — used until (or unless) the browser hands us a real fix. */
export const FALLBACK_LOCATION: LonLat = SEATTLE_CENTER;

export interface UserLocation {
  lon: number;
  lat: number;
  /** True while we are showing the Seattle-center fallback rather than a device fix. */
  approximate: boolean;
  /** null until the permission prompt resolves one way or the other. */
  error: string | null;
}

const FALLBACK_STATE: UserLocation = {
  lon: FALLBACK_LOCATION[0],
  lat: FALLBACK_LOCATION[1],
  approximate: true,
  error: null,
};

/**
 * Browser geolocation with an honest fallback. The `approximate` flag is
 * surfaced in the UI — a location we guessed is never presented as a fact.
 */
export function useUserLocation(): UserLocation {
  const [location, setLocation] = useState<UserLocation>(FALLBACK_STATE);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocation({ ...FALLBACK_STATE, error: "Geolocation unavailable" });
      return;
    }

    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (cancelled) return;
        setLocation({
          lon: position.coords.longitude,
          lat: position.coords.latitude,
          approximate: false,
          error: null,
        });
      },
      (err) => {
        if (cancelled) return;
        setLocation({ ...FALLBACK_STATE, error: err.message });
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 60_000 },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  return location;
}

export function toLonLat(location: { lon: number; lat: number }): LonLat {
  return [location.lon, location.lat];
}
