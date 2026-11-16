"use client";

/**
 * Shared server reads. Each one lives in TanStack Query so every component
 * reads the same cache entry and the same freshness.
 */
import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_RADIUS_M,
  fetchEnvironment,
  fetchFireDetections,
  fetchHealth,
  fetchResources,
} from "./api";

function anchorKey(lat: number, lon: number): [string, string] {
  return [lat.toFixed(3), lon.toFixed(3)];
}

export function useResources(lat: number, lon: number) {
  return useQuery({
    queryKey: ["resources", ...anchorKey(lat, lon)],
    queryFn: ({ signal }) => fetchResources({ lat, lon }, signal),
    staleTime: 30_000,
    refetchInterval: 120_000,
    retry: 1,
  });
}

export function useEnvironment(lat: number, lon: number) {
  return useQuery({
    queryKey: ["environment", ...anchorKey(lat, lon)],
    queryFn: ({ signal }) => fetchEnvironment({ lat, lon, radius_m: DEFAULT_RADIUS_M }, signal),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  });
}

/** Fire footprints: their own query, never merged into the event list. */
export function useFireDetections(lat: number, lon: number) {
  return useQuery({
    queryKey: ["fire-detections", ...anchorKey(lat, lon)],
    queryFn: ({ signal }) =>
      fetchFireDetections({ lat, lon, radius_m: 25_000 }, signal),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  });
}

export function useSourceHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 0,
  });
}
