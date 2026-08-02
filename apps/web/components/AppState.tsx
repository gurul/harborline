"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { NearbyResource } from "@harborline/event-schema";
import type { RoutesResponse } from "../lib/api";
import { useUserLocation, type UserLocation } from "../lib/geo";

export interface AppStateValue {
  /** Device fix, or the Seattle-center fallback flagged as approximate. */
  user: UserLocation;
  /** The routing result currently drawn on the map, if any. */
  route: RoutesResponse | null;
  setRoute: (route: RoutesResponse | null) => void;
  /** Destination the route was computed toward. */
  selectedResource: NearbyResource | null;
  setSelectedResource: (resource: NearbyResource | null) => void;
  /** Event whose detail card is open on the map. */
  selectedEventId: string | null;
  setSelectedEventId: (eventId: string | null) => void;
  clearSelection: () => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const user = useUserLocation();
  const [route, setRoute] = useState<RoutesResponse | null>(null);
  const [selectedResource, setSelectedResource] = useState<NearbyResource | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const clearSelection = useCallback(() => {
    setSelectedEventId(null);
    setSelectedResource(null);
  }, []);

  const value = useMemo<AppStateValue>(
    () => ({
      user,
      route,
      setRoute,
      selectedResource,
      setSelectedResource,
      selectedEventId,
      setSelectedEventId,
      clearSelection,
    }),
    [user, route, selectedResource, selectedEventId, clearSelection],
  );

  return <AppStateContext value={value}>{children}</AppStateContext>;
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (!value) {
    throw new Error("useAppState must be used inside <AppStateProvider>");
  }
  return value;
}
