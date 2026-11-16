"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  NearbyResource,
  RouteCandidate,
  RouteRecommendation,
} from "@harborline/event-schema";
import { routeToShelter, type RoutesResponse } from "../lib/api";
import {
  FALLBACK_LOCATION,
  FALLBACK_LABEL,
  useDeviceLocation,
  type DeviceFix,
  type UserLocation,
} from "../lib/geo";
import { useIsDesktop } from "../lib/useMediaQuery";
import { usePreferences } from "./Preferences";

export type View = "now" | "alerts" | "ask" | "map";
const VIEWS: View[] = ["now", "alerts", "ask", "map"];

export type Selection = { kind: "event"; id: string } | { kind: "resource"; id: string } | null;

export type RouteState =
  | { status: "idle" }
  | { status: "loading"; destination: NearbyResource }
  | { status: "ready"; destination: NearbyResource; routes: RoutesResponse }
  | { status: "no_route"; destination: NearbyResource; candidates: RouteCandidate[]; message: string }
  | { status: "unavailable"; destination: NearbyResource; reason: string | null; message: string }
  | { status: "error"; destination: NearbyResource; message: string };

export type SettingsSection = "location" | "needs";

/** The `route` an assistant answer carries. */
export interface AnswerRoute {
  recommendation: RouteRecommendation;
  candidate: RouteCandidate;
}

export interface AppStateValue {
  /** Where "me" is: a manual pick, a device fix, or the demo default. */
  user: UserLocation;
  device: DeviceFix & { retry: () => void };

  view: View;
  setView: (view: View) => void;
  /** On a phone, switch to the Map view. On desktop the map is always visible. */
  revealMap: () => void;

  /** The one selected map item; the map, the lists and the cards all read it. */
  selection: Selection;
  select: (selection: Selection, options?: { revealMap?: boolean }) => void;
  clearSelection: () => void;
  /** Bumped to ask the map to fit the fire-detection layer. */
  fireFocusNonce: number;
  focusFire: () => void;

  route: RouteState;
  requestRoute: (destination: NearbyResource) => void;
  /** Draw the route an answer carries. Falls back to `requestRoute` when it has none. */
  showAnswerRoute: (destination: NearbyResource, answerRoute: AnswerRoute | null | undefined) => void;
  clearRoute: () => void;

  /** A question queued for the Ask view (from the banner or a cross-link). */
  pendingQuestion: { text: string; nonce: number } | null;
  ask: (text: string) => void;
  consumeQuestion: (nonce: number) => void;

  settings: { open: boolean; section: SettingsSection };
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;

  /** "Pick on the map" mode for setting a location. */
  picking: boolean;
  startPicking: () => void;
  cancelPicking: () => void;
  pickPoint: (lon: number, lat: number) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

function readViewFromUrl(): View {
  if (typeof window === "undefined") return "now";
  const value = new URLSearchParams(window.location.search).get("view");
  return VIEWS.includes(value as View) ? (value as View) : "now";
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const { preferences, loaded, update } = usePreferences();
  const isDesktop = useIsDesktop();
  const device = useDeviceLocation(loaded && preferences.locationMode === "device");

  const user = useMemo<UserLocation>(() => {
    if (preferences.locationMode === "manual" && preferences.manual) {
      return {
        lon: preferences.manual.lon,
        lat: preferences.manual.lat,
        approximate: false,
        source: "manual",
        label: preferences.manual.label,
        error: null,
      };
    }
    if (preferences.locationMode === "device" && device.status === "ok") {
      return {
        lon: device.lon,
        lat: device.lat,
        approximate: false,
        source: "device",
        label: "Your location",
        error: null,
      };
    }
    return {
      lon: FALLBACK_LOCATION[0],
      lat: FALLBACK_LOCATION[1],
      approximate: true,
      source: "demo",
      label: FALLBACK_LABEL,
      error:
        preferences.locationMode === "device" && device.status === "error" ? device.message : null,
    };
  }, [preferences.locationMode, preferences.manual, device]);

  // --- view, kept in the URL ------------------------------------------------
  const [view, setViewState] = useState<View>("now");
  const viewRef = useRef<View>("now");
  useEffect(() => {
    const sync = () => {
      viewRef.current = readViewFromUrl();
      setViewState(viewRef.current);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const setView = useCallback((next: View) => {
    if (viewRef.current === next) return;
    viewRef.current = next;
    const url = new URL(window.location.href);
    if (next === "now") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
    window.history.pushState(null, "", url);
    setViewState(next);
  }, []);
  const revealMap = useCallback(() => {
    if (!isDesktop) setView("map");
  }, [isDesktop, setView]);

  // --- selection --------------------------------------------------------------
  const [selection, setSelection] = useState<Selection>(null);
  const select = useCallback(
    (next: Selection, options?: { revealMap?: boolean }) => {
      setSelection(next);
      if (options?.revealMap) revealMap();
    },
    [revealMap],
  );
  const clearSelection = useCallback(() => setSelection(null), []);
  const [fireFocusNonce, setFireFocusNonce] = useState(0);
  const focusFire = useCallback(() => {
    setFireFocusNonce((n) => n + 1);
    revealMap();
  }, [revealMap]);

  // --- route ------------------------------------------------------------------
  const [route, setRoute] = useState<RouteState>({ status: "idle" });
  const routeRequest = useRef(0);
  const userRef = useRef(user);
  userRef.current = user;

  const requestRoute = useCallback(
    (destination: NearbyResource) => {
      const id = ++routeRequest.current;
      setRoute({ status: "loading", destination });
      setSelection({ kind: "resource", id: destination.resource_id });
      revealMap();
      const from = userRef.current;
      routeToShelter({ lat: from.lat, lon: from.lon }, destination.resource_id)
        .then((result) => {
          if (id !== routeRequest.current) return;
          if (result.kind === "ok") setRoute({ status: "ready", destination, routes: result.routes });
          else if (result.kind === "no_route")
            setRoute({ status: "no_route", destination, candidates: result.candidates, message: result.message });
          else
            setRoute({ status: "unavailable", destination, reason: result.reason, message: result.message });
        })
        .catch((err: unknown) => {
          if (id !== routeRequest.current) return;
          setRoute({
            status: "error",
            destination,
            message: err instanceof Error ? err.message : "Routing is unavailable.",
          });
        });
    },
    [revealMap],
  );
  const showAnswerRoute = useCallback(
    (destination: NearbyResource, answerRoute: AnswerRoute | null | undefined) => {
      // Use the answer's own route only when it ends at the named shelter.
      if (
        answerRoute?.recommendation &&
        answerRoute.candidate &&
        answerRoute.recommendation.destination_resource_id === destination.resource_id &&
        answerRoute.candidate.route_id === answerRoute.recommendation.route_id
      ) {
        routeRequest.current += 1;
        setRoute({
          status: "ready",
          destination,
          routes: {
            candidates: [answerRoute.candidate],
            recommendation: answerRoute.recommendation,
            routing: "demonstration",
          },
        });
        setSelection({ kind: "resource", id: destination.resource_id });
        revealMap();
        return;
      }
      requestRoute(destination);
    },
    [requestRoute, revealMap],
  );
  const clearRoute = useCallback(() => {
    routeRequest.current += 1;
    setRoute({ status: "idle" });
  }, []);

  // A route drawn from an old starting point is wrong: clear it on a move.
  const lastAnchor = useRef(`${user.lat},${user.lon}`);
  useEffect(() => {
    const anchor = `${user.lat},${user.lon}`;
    if (anchor !== lastAnchor.current) {
      lastAnchor.current = anchor;
      clearRoute();
    }
  }, [user.lat, user.lon, clearRoute]);

  // --- ask ------------------------------------------------------------------
  const [pendingQuestion, setPendingQuestion] = useState<AppStateValue["pendingQuestion"]>(null);
  const ask = useCallback(
    (text: string) => {
      setPendingQuestion({ text, nonce: Date.now() });
      setView("ask");
    },
    [setView],
  );
  const consumeQuestion = useCallback((nonce: number) => {
    setPendingQuestion((current) => (current?.nonce === nonce ? null : current));
  }, []);

  // --- settings and picking ---------------------------------------------------
  const [settings, setSettings] = useState<AppStateValue["settings"]>({
    open: false,
    section: "location",
  });
  const openSettings = useCallback((section: SettingsSection = "location") => {
    setSettings({ open: true, section });
  }, []);
  const closeSettings = useCallback(() => setSettings((s) => ({ ...s, open: false })), []);

  const [picking, setPicking] = useState(false);
  const startPicking = useCallback(() => {
    setSettings((s) => ({ ...s, open: false }));
    setPicking(true);
    revealMap();
  }, [revealMap]);
  const cancelPicking = useCallback(() => setPicking(false), []);
  const pickPoint = useCallback(
    (lon: number, lat: number) => {
      update({
        locationMode: "manual",
        manual: { lon, lat, label: "Point picked on the map" },
      });
      setPicking(false);
    },
    [update],
  );

  const value = useMemo<AppStateValue>(
    () => ({
      user,
      device,
      view,
      setView,
      revealMap,
      selection,
      select,
      clearSelection,
      fireFocusNonce,
      focusFire,
      route,
      requestRoute,
      showAnswerRoute,
      clearRoute,
      pendingQuestion,
      ask,
      consumeQuestion,
      settings,
      openSettings,
      closeSettings,
      picking,
      startPicking,
      cancelPicking,
      pickPoint,
    }),
    [
      user,
      device,
      view,
      setView,
      revealMap,
      selection,
      select,
      clearSelection,
      fireFocusNonce,
      focusFire,
      route,
      requestRoute,
      showAnswerRoute,
      clearRoute,
      pendingQuestion,
      ask,
      consumeQuestion,
      settings,
      openSettings,
      closeSettings,
      picking,
      startPicking,
      cancelPicking,
      pickPoint,
    ],
  );

  return <AppStateContext value={value}>{children}</AppStateContext>;
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (!value) throw new Error("useAppState must be used inside <AppStateProvider>");
  return value;
}
