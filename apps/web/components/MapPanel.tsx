"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Feature, FeatureCollection, Geometry as GeoJSONGeometry } from "geojson";
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  Marker as MapLibreMarker,
} from "maplibre-gl";
import {
  geometryCentroid,
  type CanonicalEvent,
  type EventType,
  type NearbyResource,
  type ResourceType,
} from "@harborline/event-schema";
import { fetchEvent, fetchResources } from "../lib/api";
import { FALLBACK_LABEL } from "../lib/geo";
import {
  CONFIDENCE_CLASS,
  CONFIDENCE_TEXT,
  EVENT_TYPE_LABEL,
  RESOURCE_STATUS_COLOR,
  RESOURCE_STATUS_TEXT,
  SEVERITY_COLOR,
  formatDistance,
  formatDuration,
  formatUpdated,
  useNow,
} from "../lib/format";
import { useLiveFeed } from "../lib/useLiveFeed";
import { useAppState } from "./AppState";

type MapLibreModule = typeof import("maplibre-gl");

const SRC_HAZARDS = "hl-hazards";
const SRC_CLOSURES = "hl-closures";
const SRC_EVENT_POINTS = "hl-event-points";
const SRC_EVENT_CHIPS = "hl-event-chips";
const SRC_RESOURCES = "hl-resources";
const SRC_ROUTE = "hl-route";

const LYR_HAZARD_FILL = "hl-hazard-fill";
const LYR_HAZARD_GLOW = "hl-hazard-glow";
const LYR_HAZARD_OUTLINE = "hl-hazard-outline";
const LYR_CLOSURE_CASING = "hl-closure-casing";
const LYR_CLOSURE_LINE = "hl-closure-line";
const LYR_ROUTE_GLOW = "hl-route-glow";
const LYR_ROUTE_LINE = "hl-route-line";
const LYR_ROUTE_DASH = "hl-route-dash";
const LYR_EVENT_POINT = "hl-event-point";
const LYR_RESOURCE_POINT = "hl-resource-point";
const LYR_EVENT_CHIP = "hl-event-chip";
const LYR_RESOURCE_CHIP = "hl-resource-chip";

/**
 * Icon chips only exist at street zooms; below this the dot/fill layers carry
 * the signal. Native `minzoom` on the symbol layers — no JS zoom listener.
 */
const CHIP_MIN_ZOOM = 12.3;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/**
 * Icon per event type. Chips are rendered as GL symbol layers from
 * canvas-rasterized images (`map.addImage`), the pattern MapLibre's own
 * examples use for custom markers. Symbols share the exact GL transform of
 * every other layer, so chips can never drift off their coordinates the way
 * DOM-positioned markers can.
 */
const EVENT_ICON: Record<EventType, string> = {
  fire: "🔥",
  flood: "🌊",
  road_closure: "🚧",
  power_outage: "⚡",
  earthquake: "🫨",
  landslide: "⛰️",
  shelter_open: "🏠",
  shelter_full: "🏠",
  transit_disruption: "🚌",
  evacuation_order: "📢",
  weather_warning: "🌪️",
};

const RESOURCE_ICON: Record<ResourceType, string> = {
  shelter: "🏠",
  hospital: "🏥",
  cooling_center: "❄️",
  food_water: "🍽️",
  charging: "🔌",
  transport_hub: "🚌",
};

/**
 * Marching-ants phases (from the MapLibre ant-path example): stepping through
 * these dasharray patterns makes a dashed line appear to flow along the route.
 */
const DASH_SEQUENCE: number[][] = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5],
];

type FilterKey = "all" | "hazards" | "shelters" | "medical" | "food_water";

const FILTER_CHIPS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "hazards", label: "Hazards" },
  { key: "shelters", label: "Shelters" },
  { key: "medical", label: "Medical" },
  { key: "food_water", label: "Food & Water" },
];

const FILTER_RESOURCE_TYPE: Partial<Record<FilterKey, ResourceType>> = {
  shelters: "shelter",
  medical: "hospital",
  food_water: "food_water",
};

type Selection =
  | { kind: "event"; id: string }
  | { kind: "resource"; id: string }
  | null;

// --- GeoJSON assembly -------------------------------------------------------

function eventFeature(event: CanonicalEvent): Feature {
  return {
    type: "Feature",
    id: event.event_id,
    geometry: event.geometry as GeoJSONGeometry,
    properties: {
      event_id: event.event_id,
      event_type: event.event_type,
      headline: event.headline,
      severity: event.severity,
      color: SEVERITY_COLOR[event.severity],
    },
  };
}

function chipImageId(emoji: string, color: string): string {
  return `hl-chip:${emoji}:${color}`;
}

function buildEventLayers(events: CanonicalEvent[]): {
  hazards: FeatureCollection;
  closures: FeatureCollection;
  points: FeatureCollection;
  chips: FeatureCollection;
} {
  const hazards: Feature[] = [];
  const closures: Feature[] = [];
  const points: Feature[] = [];
  const chips: Feature[] = [];

  for (const event of events) {
    if (event.status !== "active") continue;
    const feature = eventFeature(event);
    switch (event.geometry.type) {
      case "Polygon":
      case "MultiPolygon":
        hazards.push(feature);
        break;
      case "LineString":
        closures.push(feature);
        break;
      case "Point":
        points.push(feature);
        break;
    }
    // One icon chip at the geometry centroid, whatever the geometry kind.
    try {
      const centre = geometryCentroid(event.geometry);
      const emoji = EVENT_ICON[event.event_type] ?? "⚠️";
      const color = SEVERITY_COLOR[event.severity];
      chips.push({
        type: "Feature",
        id: `chip-${event.event_id}`,
        geometry: { type: "Point", coordinates: centre as [number, number] },
        properties: {
          event_id: event.event_id,
          emoji,
          color,
          icon: chipImageId(emoji, color),
        },
      });
    } catch {
      // Geometry we cannot place gets no chip; the base layers still draw it.
    }
  }

  return {
    hazards: { type: "FeatureCollection", features: hazards },
    closures: { type: "FeatureCollection", features: closures },
    points: { type: "FeatureCollection", features: points },
    chips: { type: "FeatureCollection", features: chips },
  };
}

function buildResourceLayer(resources: NearbyResource[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: resources.map((resource) => {
      const emoji = RESOURCE_ICON[resource.resource_type] ?? "📍";
      const color = RESOURCE_STATUS_COLOR[resource.operational_status];
      return {
        type: "Feature",
        id: resource.resource_id,
        geometry: resource.location as GeoJSONGeometry,
        properties: {
          resource_id: resource.resource_id,
          resource_type: resource.resource_type,
          name: resource.name,
          operational_status: resource.operational_status,
          emoji,
          color,
          icon: chipImageId(emoji, color),
        },
      };
    }),
  };
}

/**
 * Rasterize one chip (glow ring + dark disc + emoji) to an ImageData for
 * `map.addImage`. Drawn at 2x and registered with pixelRatio 2 so it renders
 * as a crisp ~36 CSS px chip.
 */
function makeChipImage(emoji: string, color: string): ImageData | null {
  const size = 76;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const cx = size / 2;
  const radius = 26;

  g.shadowColor = color;
  g.shadowBlur = 10;
  g.fillStyle = "rgba(19, 19, 24, 0.92)";
  g.beginPath();
  g.arc(cx, cx, radius, 0, Math.PI * 2);
  g.fill();
  g.shadowBlur = 0;

  g.lineWidth = 4;
  g.strokeStyle = color;
  g.beginPath();
  g.arc(cx, cx, radius, 0, Math.PI * 2);
  g.stroke();

  g.font = '26px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(emoji, cx, cx + 1);

  return g.getImageData(0, 0, size, size);
}

/** Register every chip image a feature collection references, once. */
function ensureChipImages(map: MapLibreMap, collection: FeatureCollection): void {
  for (const feature of collection.features) {
    const props = feature.properties as {
      icon?: string;
      emoji?: string;
      color?: string;
    } | null;
    if (!props?.icon || !props.emoji || !props.color) continue;
    if (map.hasImage(props.icon)) continue;
    const image = makeChipImage(props.emoji, props.color);
    if (image) map.addImage(props.icon, image, { pixelRatio: 2 });
  }
}

function setSourceData(
  map: MapLibreMap | null,
  sourceId: string,
  data: FeatureCollection,
): void {
  if (!map) return;
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data);
}

// --- Panel ------------------------------------------------------------------

export function MapPanel() {
  const { user, route, selectedResource, selectedEventId, setSelectedEventId } =
    useAppState();
  const now = useNow(30_000);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const glRef = useRef<MapLibreModule | null>(null);
  const userMarkerRef = useRef<MapLibreMarker | null>(null);
  const initialCenterRef = useRef<[number, number]>([user.lon, user.lat]);

  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [selection, setSelection] = useState<Selection>(null);

  const { events } = useLiveFeed({ lat: user.lat, lon: user.lon });

  const resourcesQuery = useQuery({
    queryKey: ["resources", user.lat.toFixed(3), user.lon.toFixed(3)],
    queryFn: ({ signal }) =>
      fetchResources({ lat: user.lat, lon: user.lon }, signal),
    staleTime: 30_000,
    retry: 1,
  });
  const resources = useMemo(
    () => resourcesQuery.data?.resources ?? [],
    [resourcesQuery.data],
  );

  // Keep the map's selection and the shared app-level selection in step.
  useEffect(() => {
    if (selectedEventId) setSelection({ kind: "event", id: selectedEventId });
  }, [selectedEventId]);

  // --- map bootstrap --------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let map: MapLibreMap | null = null;
    let resizeObserver: ResizeObserver | null = null;

    void (async () => {
      const container = containerRef.current;
      if (!container) return;
      let gl: MapLibreModule;
      try {
        gl = await import("maplibre-gl");
      } catch (err) {
        if (!cancelled) setMapError((err as Error).message);
        return;
      }
      if (cancelled) return;
      glRef.current = gl;

      // Turbopack does not emit MapLibre's `new URL(...)` worker chunk from
      // node_modules, so the default worker never loads and every GeoJSON
      // source hangs forever (layers exist but nothing renders). The worker
      // and its shared-chunk import are copied into public/maplibre by the
      // `sync-maplibre-worker` script (predev/prebuild).
      gl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

      map = new gl.Map({
        container,
        center: initialCenterRef.current,
        zoom: 13.5,
        attributionControl: { compact: true },
        style: {
          version: 8,
          sources: {
            carto: {
              type: "raster",
              tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
              tileSize: 256,
              attribution: "© OpenStreetMap contributors © CARTO",
            },
          },
          layers: [{ id: "carto", type: "raster", source: "carto" }],
        },
      });
      mapRef.current = map;

      // Deterministic mounting: own the container→canvas size contract instead
      // of trusting MapLibre's internal ResizeObserver, which under the Next
      // dev runtime can miss layout changes — the canvas then CSS-stretches
      // over a stale GL viewport and every layer drifts off its coordinates
      // while DOM markers (positioned in real container pixels) stay put.
      resizeObserver = new ResizeObserver(() => {
        mapRef.current?.resize();
      });
      resizeObserver.observe(container);

      map.addControl(new gl.NavigationControl({ showCompass: false }), "top-right");
      map.getCanvas().setAttribute("aria-label", "Hazard and resource map");

      map.on("load", () => {
        if (cancelled || !map) return;

        // Re-sync once at load: the container may have changed size between
        // construction and style readiness (fonts, grid settling).
        map.resize();

        map.addSource(SRC_HAZARDS, { type: "geojson", data: EMPTY });
        map.addSource(SRC_CLOSURES, { type: "geojson", data: EMPTY });
        map.addSource(SRC_EVENT_POINTS, { type: "geojson", data: EMPTY });
        map.addSource(SRC_EVENT_CHIPS, { type: "geojson", data: EMPTY });
        map.addSource(SRC_RESOURCES, { type: "geojson", data: EMPTY });
        map.addSource(SRC_ROUTE, { type: "geojson", data: EMPTY });

        // Hazard zones: translucent fill + a wide blurred "ember" glow that the
        // animation loop breathes, + a crisp outline.
        map.addLayer({
          id: LYR_HAZARD_FILL,
          type: "fill",
          source: SRC_HAZARDS,
          paint: { "fill-color": ["get", "color"], "fill-opacity": 0.22 },
        });
        map.addLayer({
          id: LYR_HAZARD_GLOW,
          type: "line",
          source: SRC_HAZARDS,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["get", "color"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 9, 3, 12, 7, 14, 11],
            "line-blur": ["interpolate", ["linear"], ["zoom"], 9, 2, 14, 7],
            "line-opacity": 0.45,
          },
        });
        map.addLayer({
          id: LYR_HAZARD_OUTLINE,
          type: "line",
          source: SRC_HAZARDS,
          paint: {
            "line-color": ["get", "color"],
            "line-width": 2,
            "line-opacity": 0.9,
          },
        });
        // Closures: dark casing under an animated red dashed line.
        map.addLayer({
          id: LYR_CLOSURE_CASING,
          type: "line",
          source: SRC_CLOSURES,
          layout: { "line-cap": "round" },
          paint: {
            "line-color": "#7f1d1d",
            "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 8],
            "line-blur": 2,
            "line-opacity": 0.55,
          },
        });
        map.addLayer({
          id: LYR_CLOSURE_LINE,
          type: "line",
          source: SRC_CLOSURES,
          paint: {
            "line-color": "#ef4444",
            "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 4],
            "line-dasharray": [2, 1.5],
          },
        });
        // Route: teal glow casing + solid core + a bright flowing dash overlay.
        map.addLayer({
          id: LYR_ROUTE_GLOW,
          type: "line",
          source: SRC_ROUTE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#14b8a6",
            "line-width": 14,
            "line-blur": 9,
            "line-opacity": 0.4,
          },
        });
        map.addLayer({
          id: LYR_ROUTE_LINE,
          type: "line",
          source: SRC_ROUTE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#14b8a6", "line-width": 5, "line-opacity": 0.95 },
        });
        map.addLayer({
          id: LYR_ROUTE_DASH,
          type: "line",
          source: SRC_ROUTE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#ccfbf1",
            "line-width": 2.5,
            "line-dasharray": DASH_SEQUENCE[0],
          },
        });
        map.addLayer({
          id: LYR_EVENT_POINT,
          type: "circle",
          source: SRC_EVENT_POINTS,
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3.5, 12, 5, 14, 7],
            "circle-color": ["get", "color"],
            "circle-stroke-color": "#0a0a0c",
            "circle-stroke-width": 2,
          },
        });
        // Resource dots: a small status-coloured point at every zoom, growing
        // into the soft halo that sits under the DOM chips at street zooms.
        map.addLayer({
          id: LYR_RESOURCE_POINT,
          type: "circle",
          source: SRC_RESOURCES,
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 4, 12, 8, 14, 15],
            "circle-color": ["get", "color"],
            "circle-opacity": [
              "interpolate",
              ["linear"],
              ["zoom"],
              11.5,
              0.85,
              12.5,
              0.18,
            ],
            "circle-stroke-color": ["get", "color"],
            "circle-stroke-opacity": 0.5,
            "circle-stroke-width": 1,
          },
        });

        // Icon chips as GL symbols (MapLibre's custom-marker pattern): they
        // render in the same GL pass as everything else, so they are pinned
        // to their coordinates by construction. `minzoom` gates them to
        // street zooms natively.
        map.addLayer({
          id: LYR_RESOURCE_CHIP,
          type: "symbol",
          source: SRC_RESOURCES,
          minzoom: CHIP_MIN_ZOOM,
          layout: {
            "icon-image": ["get", "icon"],
            "icon-size": ["interpolate", ["linear"], ["zoom"], CHIP_MIN_ZOOM, 0.8, 14.5, 1],
            "icon-allow-overlap": true,
          },
        });
        map.addLayer({
          id: LYR_EVENT_CHIP,
          type: "symbol",
          source: SRC_EVENT_CHIPS,
          minzoom: CHIP_MIN_ZOOM,
          layout: {
            "icon-image": ["get", "icon"],
            "icon-size": ["interpolate", ["linear"], ["zoom"], CHIP_MIN_ZOOM, 0.8, 14.5, 1],
            "icon-allow-overlap": true,
          },
        });

        const clickableEventLayers = [
          LYR_HAZARD_FILL,
          LYR_CLOSURE_LINE,
          LYR_EVENT_POINT,
          LYR_EVENT_CHIP,
        ];
        for (const layerId of clickableEventLayers) {
          map.on("click", layerId, (e: MapLayerMouseEvent) => {
            const id = e.features?.[0]?.properties?.["event_id"];
            if (typeof id === "string") setSelection({ kind: "event", id });
          });
          map.on("mouseenter", layerId, () => {
            if (map) map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", layerId, () => {
            if (map) map.getCanvas().style.cursor = "";
          });
        }

        for (const layerId of [LYR_RESOURCE_POINT, LYR_RESOURCE_CHIP]) {
          map.on("click", layerId, (e: MapLayerMouseEvent) => {
            const id = e.features?.[0]?.properties?.["resource_id"];
            if (typeof id === "string") setSelection({ kind: "resource", id });
          });
          map.on("mouseenter", layerId, () => {
            if (map) map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", layerId, () => {
            if (map) map.getCanvas().style.cursor = "";
          });
        }

        setMapReady(true);
      });

      map.on("error", (e) => {
        // Tile errors are noisy and non-fatal; keep them out of the UI.
        if (process.env.NODE_ENV === "development") console.warn("[map]", e.error);
      });
    })();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // --- data → sources -------------------------------------------------------
  const eventLayers = useMemo(() => buildEventLayers(events), [events]);
  const resourceLayer = useMemo(() => buildResourceLayer(resources), [resources]);

  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (map) ensureChipImages(map, eventLayers.chips);
    setSourceData(map, SRC_HAZARDS, eventLayers.hazards);
    setSourceData(map, SRC_CLOSURES, eventLayers.closures);
    setSourceData(map, SRC_EVENT_POINTS, eventLayers.points);
    setSourceData(map, SRC_EVENT_CHIPS, eventLayers.chips);
  }, [mapReady, eventLayers]);

  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (map) ensureChipImages(map, resourceLayer);
    setSourceData(map, SRC_RESOURCES, resourceLayer);
  }, [mapReady, resourceLayer]);

  // --- ambient animation: breathing hazard glow, flowing route, ant closures
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let routeStep = -1;
    let closureStep = -1;
    const loop = (ts: number) => {
      if (map.isStyleLoaded()) {
        const breathe = (Math.sin(ts / 550) + 1) / 2; // 0..1
        if (map.getLayer(LYR_HAZARD_GLOW)) {
          map.setPaintProperty(LYR_HAZARD_GLOW, "line-opacity", 0.25 + breathe * 0.45);
          map.setPaintProperty(LYR_HAZARD_FILL, "fill-opacity", 0.16 + breathe * 0.12);
        }
        const nextRoute = Math.floor(ts / 70) % DASH_SEQUENCE.length;
        if (nextRoute !== routeStep && map.getLayer(LYR_ROUTE_DASH)) {
          routeStep = nextRoute;
          map.setPaintProperty(LYR_ROUTE_DASH, "line-dasharray", DASH_SEQUENCE[nextRoute]);
        }
        const nextClosure = Math.floor(ts / 160) % DASH_SEQUENCE.length;
        if (nextClosure !== closureStep && map.getLayer(LYR_CLOSURE_LINE)) {
          closureStep = nextClosure;
          map.setPaintProperty(LYR_CLOSURE_LINE, "line-dasharray", DASH_SEQUENCE[nextClosure]);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [mapReady]);

  const hazardsVisible = filter === "all" || filter === "hazards";
  const resourcesVisible = filter !== "hazards";
  const resourceTypeFilter = FILTER_RESOURCE_TYPE[filter];

  // --- recommended route ----------------------------------------------------
  const recommendedCandidate = useMemo(() => {
    if (!route?.recommendation) return null;
    return (
      route.candidates.find((c) => c.route_id === route.recommendation?.route_id) ??
      null
    );
  }, [route]);

  useEffect(() => {
    if (!mapReady) return;
    const geometry = recommendedCandidate?.geometry;
    setSourceData(
      mapRef.current,
      SRC_ROUTE,
      geometry
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: geometry as GeoJSONGeometry,
                properties: {},
              },
            ],
          }
        : EMPTY,
    );
  }, [mapReady, recommendedCandidate]);

  // Fit the recommended route once it appears.
  useEffect(() => {
    const map = mapRef.current;
    const gl = glRef.current;
    if (!mapReady || !map || !gl || !recommendedCandidate) return;
    const coords = recommendedCandidate.geometry.coordinates;
    if (coords.length < 2) return;
    const bounds = coords.reduce(
      (acc, coord) => acc.extend(coord as [number, number]),
      new gl.LngLatBounds(
        coords[0] as [number, number],
        coords[0] as [number, number],
      ),
    );
    map.fitBounds(bounds, { padding: 96, maxZoom: 15.5, duration: 900 });
  }, [mapReady, recommendedCandidate]);

  // --- user dot -------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const gl = glRef.current;
    if (!mapReady || !map || !gl) return;

    if (!userMarkerRef.current) {
      const element = document.createElement("div");
      element.className = "hl-user-dot";
      element.setAttribute("aria-hidden", "true");
      userMarkerRef.current = new gl.Marker({ element })
        .setLngLat([user.lon, user.lat])
        .addTo(map);
    } else {
      userMarkerRef.current.setLngLat([user.lon, user.lat]);
    }
  }, [mapReady, user.lon, user.lat]);

  // Recentre when a real device fix replaces the fallback.
  useEffect(() => {
    if (!mapReady || user.approximate) return;
    mapRef.current?.easeTo({ center: [user.lon, user.lat], zoom: 13.5, duration: 800 });
  }, [mapReady, user.approximate, user.lon, user.lat]);

  // --- filter chips ---------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;

    for (const layerId of [
      LYR_HAZARD_FILL,
      LYR_HAZARD_GLOW,
      LYR_HAZARD_OUTLINE,
      LYR_CLOSURE_CASING,
      LYR_CLOSURE_LINE,
      LYR_EVENT_POINT,
      LYR_EVENT_CHIP,
    ]) {
      map.setLayoutProperty(layerId, "visibility", hazardsVisible ? "visible" : "none");
    }
    for (const layerId of [LYR_RESOURCE_POINT, LYR_RESOURCE_CHIP]) {
      map.setLayoutProperty(
        layerId,
        "visibility",
        resourcesVisible ? "visible" : "none",
      );
      map.setFilter(
        layerId,
        resourceTypeFilter
          ? ["==", ["get", "resource_type"], resourceTypeFilter]
          : null,
      );
    }
  }, [mapReady, hazardsVisible, resourcesVisible, resourceTypeFilter]);

  // --- detail card ----------------------------------------------------------
  const detailEventQuery = useQuery({
    queryKey: ["event", selection?.kind === "event" ? selection.id : null],
    queryFn: ({ signal }) =>
      fetchEvent((selection as { kind: "event"; id: string }).id, signal),
    enabled: selection?.kind === "event",
    staleTime: 30_000,
    retry: 1,
  });

  const selectedEvent =
    selection?.kind === "event"
      ? (detailEventQuery.data?.event ??
        events.find((e) => e.event_id === selection.id) ??
        null)
      : null;
  const selectedEventSources = detailEventQuery.data?.source_records ?? [];

  const detailResource =
    selection?.kind === "resource"
      ? (resources.find((r) => r.resource_id === selection.id) ?? null)
      : null;

  function closeDetail() {
    setSelection(null);
    setSelectedEventId(null);
  }

  const recommendation = route?.recommendation ?? null;

  return (
    <section
      aria-label="Hazard map"
      className="relative flex min-h-[420px] flex-col overflow-hidden rounded-2xl border border-hl-line bg-hl-panel lg:min-h-0"
    >
      {/* Inline position: MapLibre's injected stylesheet sets
          `.maplibregl-map { position: relative }` after Tailwind's utilities,
          which silently beats `absolute` in the cascade and collapses the
          container to the height of the injected controls. */}
      <div ref={containerRef} className="absolute inset-0" style={{ position: "absolute" }} />

      {mapError ? (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-hl-muted">
          Map could not be loaded ({mapError}). Records remain available in the feed.
        </div>
      ) : null}

      {/* Filter chips */}
      <div className="pointer-events-none relative z-10 flex flex-wrap gap-2 p-3 sm:p-4">
        {FILTER_CHIPS.map((chip) => {
          const active = filter === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(chip.key)}
              className={[
                "pointer-events-auto inline-flex min-h-11 items-center rounded-full border px-4 text-xs font-medium backdrop-blur-md transition-colors",
                active
                  ? "border-white/25 bg-white/95 text-hl-bg"
                  : "border-hl-line bg-hl-bg/75 text-hl-muted hover:text-white",
              ].join(" ")}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {user.approximate ? (
        <div className="pointer-events-none relative z-10 px-3 sm:px-4">
          <span className="inline-flex items-center gap-2 rounded-full border border-hl-line bg-hl-bg/80 px-3 py-1.5 text-[11px] text-hl-muted backdrop-blur-md">
            Using approximate location — {FALLBACK_LABEL}
          </span>
        </div>
      ) : null}

      {/* Detail card */}
      {selectedEvent ? (
        <div className="pointer-events-auto absolute inset-x-3 bottom-24 z-20 rounded-2xl border border-hl-line bg-hl-panel/95 p-4 shadow-2xl backdrop-blur-md sm:inset-x-4 sm:max-w-md">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={[
                  "rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-wide uppercase",
                  CONFIDENCE_CLASS[selectedEvent.confidence_label],
                ].join(" ")}
              >
                {CONFIDENCE_TEXT[selectedEvent.confidence_label]}
              </span>
              <span className="rounded-full border border-hl-line bg-hl-raised px-2.5 py-1 text-[10px] text-hl-muted">
                {EVENT_TYPE_LABEL[selectedEvent.event_type]}
              </span>
            </div>
            <button
              type="button"
              onClick={closeDetail}
              aria-label="Close detail"
              className="-m-2 inline-flex h-11 w-11 items-center justify-center rounded-full text-hl-muted hover:text-white"
            >
              ✕
            </button>
          </div>

          <h3 className="mt-3 text-sm leading-snug font-semibold text-white">
            {selectedEvent.headline}
          </h3>
          <p className="mt-1 text-[11px] text-hl-dim">
            {formatUpdated(selectedEvent.last_verified_at, now)} ·{" "}
            {selectedEventSources.length > 0
              ? selectedEventSources.map((s) => s.provider).join(", ")
              : `Tier ${selectedEvent.best_tier} source`}
          </p>
          <p className="mt-3 max-h-32 overflow-y-auto text-xs leading-relaxed text-hl-muted">
            {selectedEvent.description}
          </p>
          {selectedEvent.contradiction_note ? (
            <p className="mt-3 rounded-xl border border-hl-amber/30 bg-hl-amber-soft/60 p-2.5 text-[11px] italic text-hl-amber">
              {selectedEvent.contradiction_note}
            </p>
          ) : null}
        </div>
      ) : null}

      {detailResource ? (
        <div className="pointer-events-auto absolute inset-x-3 bottom-24 z-20 rounded-2xl border border-hl-line bg-hl-panel/95 p-4 shadow-2xl backdrop-blur-md sm:inset-x-4 sm:max-w-md">
          <div className="flex items-start justify-between gap-3">
            <span
              className={[
                "rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-wide uppercase",
                detailResource.operational_status === "open"
                  ? "border-hl-green/40 bg-hl-green-soft text-hl-green"
                  : detailResource.operational_status === "full"
                    ? "border-hl-amber/40 bg-hl-amber-soft text-hl-amber"
                    : "border-hl-line bg-hl-raised text-hl-muted",
              ].join(" ")}
            >
              {RESOURCE_STATUS_TEXT[detailResource.operational_status]}
            </span>
            <button
              type="button"
              onClick={closeDetail}
              aria-label="Close detail"
              className="-m-2 inline-flex h-11 w-11 items-center justify-center rounded-full text-hl-muted hover:text-white"
            >
              ✕
            </button>
          </div>
          <h3 className="mt-3 text-sm font-semibold text-white">
            {detailResource.name}
          </h3>
          <p className="mt-1 text-[11px] text-hl-dim">
            {formatUpdated(detailResource.last_verified_at, now)} ·{" "}
            {detailResource.provider} · Tier {detailResource.provider_tier}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-hl-muted">
            <div>
              <dt className="text-hl-dim">Distance</dt>
              <dd>{formatDistance(detailResource.distance_m)}</dd>
            </div>
            <div>
              <dt className="text-hl-dim">Capacity</dt>
              <dd>
                {detailResource.capacity_available !== null &&
                detailResource.capacity_total !== null
                  ? `${detailResource.capacity_available} of ${detailResource.capacity_total} free`
                  : "Not reported"}
              </dd>
            </div>
            {detailResource.accessibility_features.length > 0 ? (
              <div className="col-span-2">
                <dt className="text-hl-dim">Accessibility</dt>
                <dd>{detailResource.accessibility_features.join(", ")}</dd>
              </div>
            ) : null}
            {detailResource.pet_policy ? (
              <div className="col-span-2">
                <dt className="text-hl-dim">Pets</dt>
                <dd>{detailResource.pet_policy}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}

      {/* Route bar */}
      {recommendation ? (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 sm:inset-x-4 sm:bottom-4">
          <div className="rounded-2xl border border-hl-teal/30 bg-hl-bg/90 p-3.5 backdrop-blur-md">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs leading-snug font-medium text-white">
                {recommendation.summary}
              </p>
              <span className="rounded-full border border-hl-line bg-hl-raised px-2.5 py-1 text-[10px] tracking-wide text-hl-dim uppercase">
                demonstration routing
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-hl-teal">
              {formatDuration(recommendation.duration_min)} · avoids{" "}
              {recommendation.avoided_hazard_count}{" "}
              {recommendation.avoided_hazard_count === 1 ? "hazard" : "hazards"}
              {selectedResource ? ` · ${selectedResource.name}` : ""}
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default MapPanel;
