"use client";

import { useSyncExternalStore } from "react";

const subscribers = new Map<string, (onChange: () => void) => () => void>();

function subscribeTo(query: string) {
  const cached = subscribers.get(query);
  if (cached) return cached;
  const subscribe = (onChange: () => void) => {
    if (typeof window === "undefined") return () => {};
    const list = window.matchMedia(query);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  };
  subscribers.set(query, subscribe);
  return subscribe;
}

/** Live media-query match. `serverValue` is used for the first render. */
export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    subscribeTo(query),
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

export const DESKTOP_QUERY = "(min-width: 1024px)";

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY, true);
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)", false);
}

/** Read once, outside React (map camera calls). */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
