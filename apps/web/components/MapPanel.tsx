"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Feature, FeatureCollection, Geometry as GeoJSONGeometry } from "geojson";
import type {
  LngLatBoundsLike,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  MapMouseEvent,
  Marker as MapLibreMarker,
} from "maplibre-gl";
import {
  geometryCentroid,
  type CanonicalEvent,
  type EventType,
  type Geometry,
  type ResourceType,
  type NearbyResource,
} from "@harborline/event-schema";
import {
  CONFIDENCE_TEXT,
  RESOURCE_STATUS_COLOR,
  SEVERITY_COLOR,
  SEVERITY_TONE,
  SEVERITY_WORD,
  TONE_TEXT_CLASS,
  eventTypeLabel,
  formatAge,
  useNow,
} from "../lib/format";
import {
  EMPTY,
  EVENT_CLICK_LAYERS,
  FALLBACK_STYLE,
  LYR,
  RESOURCE_CLICK_LAYERS,
  SRC,
  applyLayerVisibility,
  defaultLayers,
  installOverlayLayers,
  installSatellite,
  loadBasemapStyle,
  setSourceData,
  type LayerState,
} from "../lib/mapLayers";
import { useFireDetections, useResources } from "../lib/queries";
import { useLiveFeed } from "../lib/useLiveFeed";
import { prefersReducedMotion, useIsDesktop } from "../lib/useMediaQuery";
import { useAppState } from "./AppState";
import { LayerMenu } from "./LayerMenu";
import { PlaceCard } from "./PlaceCard";
import { RouteBar } from "./RouteBar";
import { Button } from "./ui";

type MapLibreModule = typeof import("maplibre-gl");

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
  fire_detection: "🛰️",
  fire_perimeter: "🔥",
};

const RESOURCE_ICON: Record<ResourceType, string> = {
  shelter: "🏠",
  hospital: "🏥",
  cooling_center: "❄️",
  food_water: "🍽️",
  charging: "🔌",
  transport_hub: "🚌",
};

// --- GeoJSON assembly -------------------------------------------------------

function chipImageId(emoji: string, color: string): string {
  return `hl-chip:${emoji}:${color}`;
}

function buildEventLayers(events: CanonicalEvent[]) {
  const hazards: Feature[] = [];
  const closures: Feature[] = [];
  const points: Feature[] = [];
  const chips: Feature[] = [];

  for (const event of events) {
    if (event.status !== "active") continue;
    const color = SEVERITY_COLOR[event.severity];
    const feature: Feature = {
      type: "Feature",
      id: event.event_id,
      geometry: event.geometry as GeoJSONGeometry,
      properties: { event_id: event.event_id, severity: event.severity, color },
    };
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
    try {
      const centre = geometryCentroid(event.geometry);
      const emoji = EVENT_ICON[event.event_type] ?? "⚠️";
      chips.push({
        type: "Feature",
        id: `chip-${event.event_id}`,
        geometry: { type: "Point", coordinates: centre as [number, number] },
        properties: { event_id: event.event_id, emoji, color, icon: chipImageId(emoji, color) },
      });
    } catch {
      // Geometry we cannot place gets no chip; the base layers still draw it.
    }
  }

  const fc = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });
  return { hazards: fc(hazards), closures: fc(closures), points: fc(points), chips: fc(chips) };
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
          emoji,
          color,
          icon: chipImageId(emoji, color),
        },
      };
    }),
  };
}

/** Fire footprints: polygons only, no icon. `age_h` drives the colour step. */
function buildFireLayer(detections: CanonicalEvent[], now: Date): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: detections.map((d) => {
      const observed = new Date(d.starts_at ?? d.last_verified_at).getTime();
      const ageH = Number.isNaN(observed) ? 99 : Math.max(0, (now.getTime() - observed) / 3_600_000);
      return {
        type: "Feature",
        id: d.event_id,
        geometry: d.geometry as GeoJSONGeometry,
        properties: { event_id: d.event_id, age_h: ageH },
      };
    }),
  };
}

function makeChipImage(emoji: string, color: string): ImageData | null {
  const size = 76;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const cx = size / 2;
  const radius = 26;
  g.fillStyle = "rgba(19, 19, 24, 0.94)";
  g.beginPath();
  g.arc(cx, cx, radius, 0, Math.PI * 2);
  g.fill();
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

function ensureChipImages(map: MapLibreMap, collection: FeatureCollection): void {
  for (const feature of collection.features) {
    const props = feature.properties as { icon?: string; emoji?: string; color?: string } | null;
    if (!props?.icon || !props.emoji || !props.color) continue;
    if (map.hasImage(props.icon)) continue;
    const image = makeChipImage(props.emoji, props.color);
    if (image) map.addImage(props.icon, image, { pixelRatio: 2 });
  }
}

function geometryBounds(geometries: Geometry[]): LngLatBoundsLike | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (coords: unknown): void => {
    if (Array.isArray(coords) && typeof coords[0] === "number" && typeof coords[1] === "number") {
      minX = Math.min(minX, coords[0]);
      maxX = Math.max(maxX, coords[0]);
      minY = Math.min(minY, coords[1]);
      maxY = Math.max(maxY, coords[1]);
      return;
    }
    if (Array.isArray(coords)) for (const c of coords) visit(c);
  };
  for (const g of geometries) visit(g.coordinates);
  if (!Number.isFinite(minX)) return null;
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}

const cameraDuration = () => (prefersReducedMotion() ? 0 : 300);

// --- Panel ------------------------------------------------------------------

export function MapPanel() {
  const {
    user,
    route,
    selection,
    select,
    clearSelection,
    requestRoute,
    clearRoute,
    setView,
    fireFocusNonce,
    picking,
    cancelPicking,
    pickPoint,
  } = useAppState();
  const isDesktop = useIsDesktop();
  const now = useNow(60_000);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const glRef = useRef<MapLibreModule | null>(null);
  const userMarkerRef = useRef<MapLibreMarker | null>(null);
  const initialCenterRef = useRef<[number, number]>([user.lon, user.lat]);

  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [basemapProblem, setBasemapProblem] = useState<string | null>(null);
  const [layers, setLayers] = useState<LayerState>(defaultLayers);

  const feed = useLiveFeed({ lat: user.lat, lon: user.lon });
  const events = feed.events;
  const resourcesQuery = useResources(user.lat, user.lon);
  const resources = useMemo(() => resourcesQuery.data?.resources ?? [], [resourcesQuery.data]);
  const fireQuery = useFireDetections(user.lat, user.lon);
  const detections = useMemo(
    () => (fireQuery.data?.kind === "ok" ? fireQuery.data.events : []),
    [fireQuery.data],
  );

  // Handlers registered once at load read the latest values through refs.
  const handlers = useRef({
    onEvent: (_id: string) => {},
    onResource: (_id: string) => {},
    onPick: (_lon: number, _lat: number) => {},
    picking: false,
  });
  handlers.current = {
    onEvent: (id) => {
      select({ kind: "event", id });
      if (isDesktop) setView("alerts");
    },
    onResource: (id) => select({ kind: "resource", id }),
    onPick: pickPoint,
    picking,
  };

  // --- bootstrap ------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let map: MapLibreMap | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let tileErrors = 0;
    let tileLoads = 0;

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
      const basemap = await loadBasemapStyle();
      if (cancelled) return;
      glRef.current = gl;
      if (!basemap) {
        setBasemapProblem("Street map could not load. Hazards and places are still drawn.");
      }

      // Turbopack does not emit MapLibre's worker chunk from node_modules; the
      // worker is copied to public/maplibre by `sync-maplibre-worker`.
      gl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

      map = new gl.Map({
        container,
        center: initialCenterRef.current,
        zoom: 13.5,
        attributionControl: { compact: true },
        style: basemap ?? FALLBACK_STYLE,
      });
      mapRef.current = map;
      const basemapSources = new Set(Object.keys((basemap ?? FALLBACK_STYLE).sources));

      resizeObserver = new ResizeObserver(() => mapRef.current?.resize());
      resizeObserver.observe(container);

      map.addControl(new gl.NavigationControl({ showCompass: false }), "top-right");
      map.getCanvas().setAttribute("aria-label", "Map of hazards and places. Use the lists to reach each item.");

      // A tile that fails, or returns an error image the decoder rejects,
      // surfaces as an `error` with a sourceId. Count them against successes.
      map.on("error", (e) => {
        const sourceId = (e as unknown as { sourceId?: string }).sourceId;
        if (sourceId && basemapSources.has(sourceId)) {
          tileErrors += 1;
          if (tileErrors >= 3 && tileLoads === 0 && !cancelled) {
            setBasemapProblem("Street map tiles are not loading. Hazards and places are still drawn.");
          }
        }
        if (process.env.NODE_ENV === "development") console.warn("[map]", e.error);
      });
      map.on("data", (e) => {
        const ev = e as unknown as { dataType?: string; sourceId?: string; tile?: unknown };
        if (ev.dataType === "source" && ev.tile && ev.sourceId && basemapSources.has(ev.sourceId)) {
          tileLoads += 1;
          if (tileLoads === 1 && basemap && !cancelled) setBasemapProblem(null);
        }
      });

      map.on("load", () => {
        if (cancelled || !map) return;
        map.resize();
        installOverlayLayers(map);

        for (const layerId of EVENT_CLICK_LAYERS) {
          map.on("click", layerId, (e: MapLayerMouseEvent) => {
            if (handlers.current.picking) return;
            const id = e.features?.[0]?.properties?.["event_id"];
            if (typeof id === "string") handlers.current.onEvent(id);
          });
        }
        for (const layerId of RESOURCE_CLICK_LAYERS) {
          map.on("click", layerId, (e: MapLayerMouseEvent) => {
            if (handlers.current.picking) return;
            const id = e.features?.[0]?.properties?.["resource_id"];
            if (typeof id === "string") handlers.current.onResource(id);
          });
        }
        for (const layerId of [...EVENT_CLICK_LAYERS, ...RESOURCE_CLICK_LAYERS]) {
          map.on("mouseenter", layerId, () => {
            if (map) map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", layerId, () => {
            if (map) map.getCanvas().style.cursor = "";
          });
        }
        map.on("click", (e: MapMouseEvent) => {
          if (handlers.current.picking) handlers.current.onPick(e.lngLat.lng, e.lngLat.lat);
        });

        setMapReady(true);
      });
    })();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
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
  const fireLayer = useMemo(() => buildFireLayer(detections, now), [detections, now]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    ensureChipImages(map, eventLayers.chips);
    setSourceData(map, SRC.hazards, eventLayers.hazards);
    setSourceData(map, SRC.closures, eventLayers.closures);
    setSourceData(map, SRC.eventPoints, eventLayers.points);
    setSourceData(map, SRC.eventChips, eventLayers.chips);
  }, [mapReady, eventLayers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    ensureChipImages(map, resourceLayer);
    setSourceData(map, SRC.resources, resourceLayer);
  }, [mapReady, resourceLayer]);

  useEffect(() => {
    if (mapReady) setSourceData(mapRef.current, SRC.fire, fireLayer);
  }, [mapReady, fireLayer]);

  // --- satellite + visibility -------------------------------------------------
  const satelliteDateRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    if (satelliteDateRef.current !== layers.satelliteDate) {
      satelliteDateRef.current = layers.satelliteDate;
      installSatellite(map, layers.satelliteDate, layers.basemap === "satellite");
    }
    applyLayerVisibility(map, layers);
  }, [mapReady, layers]);

  // --- route ------------------------------------------------------------------
  const routeGeometry = useMemo(() => {
    if (route.status !== "ready") return null;
    const rec = route.routes.recommendation;
    return route.routes.candidates.find((c) => c.route_id === rec?.route_id)?.geometry ?? null;
  }, [route]);

  useEffect(() => {
    const map = mapRef.current;
    const gl = glRef.current;
    if (!mapReady || !map) return;
    setSourceData(
      map,
      SRC.route,
      routeGeometry
        ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: routeGeometry as GeoJSONGeometry, properties: {} }] }
        : EMPTY,
    );
    if (routeGeometry && gl) {
      const bounds = geometryBounds([routeGeometry]);
      // Leave room for the route bar at the bottom.
      const padding = isDesktop
        ? { top: 80, bottom: 220, left: 60, right: 60 }
        : { top: 70, bottom: 260, left: 30, right: 30 };
      if (bounds) map.fitBounds(bounds, { padding, maxZoom: 15.5, duration: cameraDuration() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, routeGeometry]);

  // --- selection: highlight and camera follow -----------------------------------
  const selectedResource =
    selection?.kind === "resource" ? (resources.find((r) => r.resource_id === selection.id) ?? null) : null;
  const selectedEvent =
    selection?.kind === "event" ? (events.find((e) => e.event_id === selection.id) ?? null) : null;

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !map.getLayer(LYR.resourceSelected)) return;
    map.setFilter(LYR.resourceSelected, ["==", ["get", "resource_id"], selectedResource?.resource_id ?? ""]);
  }, [mapReady, selectedResource?.resource_id]);

  const selectionKey = selection ? `${selection.kind}:${selection.id}` : "";
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !selectionKey) return;
    if (selectedResource && route.status === "idle") {
      map.easeTo({
        center: selectedResource.location.coordinates as [number, number],
        zoom: Math.max(map.getZoom(), 14),
        duration: cameraDuration(),
      });
    } else if (selectedEvent) {
      const bounds = geometryBounds([selectedEvent.geometry]);
      if (bounds) map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: cameraDuration() });
    }
    // Camera follows a new selection only, not every data refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, selectionKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || fireFocusNonce === 0) return;
    const bounds = geometryBounds(detections.map((d) => d.geometry));
    if (bounds) map.fitBounds(bounds, { padding: 80, maxZoom: 13, duration: cameraDuration() });
    if (!layers.fire) setLayers((l) => ({ ...l, fire: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, fireFocusNonce]);

  // --- user dot ---------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const gl = glRef.current;
    if (!mapReady || !map || !gl) return;
    if (!userMarkerRef.current) {
      const element = document.createElement("div");
      element.className = "hl-user-dot";
      element.setAttribute("aria-hidden", "true");
      userMarkerRef.current = new gl.Marker({ element }).setLngLat([user.lon, user.lat]).addTo(map);
    } else {
      userMarkerRef.current.setLngLat([user.lon, user.lat]);
    }
    map.easeTo({ center: [user.lon, user.lat], duration: cameraDuration() });
  }, [mapReady, user.lon, user.lat]);

  const fireStatus = fireQuery.isPending
    ? "Loading."
    : fireQuery.isError
      ? "Could not load detections."
      : fireQuery.data?.kind === "not_connected"
        ? "No detection source is connected."
        : `${detections.length} in view range.`;

  return (
    <section aria-labelledby="map-heading" className="relative h-full min-h-0 w-full overflow-hidden bg-hl-bg">
      <h2 id="map-heading" className="sr-only">
        Map
      </h2>
      {/* Inline position: MapLibre's stylesheet sets `.maplibregl-map
          { position: relative }`, which beats Tailwind's `absolute`. */}
      <div ref={containerRef} className="absolute inset-0" style={{ position: "absolute" }} />

      {mapError ? (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-body text-white">
          The map could not load ({mapError}). Every alert and place is still in the lists.
        </div>
      ) : null}

      {/* Top-left: layers, then any status notes. */}
      <div className="pointer-events-none absolute top-3 left-3 z-10 flex max-w-[calc(100%-5rem)] flex-col items-start gap-2">
        <LayerMenu layers={layers} onChange={setLayers} fireStatus={fireStatus} />
        {basemapProblem ? (
          <p role="status" className="pointer-events-auto rounded-xl bg-hl-panel/95 px-3 py-2 text-meta text-hl-moderate shadow-lg">
            {basemapProblem}
          </p>
        ) : null}
        {layers.basemap === "satellite" ? (
          <p className="rounded-xl bg-hl-panel/95 px-3 py-2 text-meta text-white shadow-lg">
            Satellite imagery {layers.satelliteDate} (UTC) · not live · NASA GIBS
          </p>
        ) : null}
        {user.approximate ? (
          <p className="rounded-xl bg-hl-panel/95 px-3 py-2 text-meta text-white shadow-lg">
            Approximate location: {user.label}
          </p>
        ) : null}
      </div>

      {picking ? (
        <div className="absolute inset-x-3 top-16 z-20 flex items-center justify-between gap-3 rounded-2xl bg-hl-panel p-4 shadow-2xl">
          <p role="status" className="text-body text-white">
            Tap the map where you are.
          </p>
          <Button onClick={cancelPicking}>Cancel</Button>
        </div>
      ) : null}

      {/* Bottom: place or alert card, then the route. */}
      <div className="pointer-events-none absolute inset-x-3 bottom-8 z-20 flex flex-col gap-2 sm:max-w-md">
        {selectedResource &&
        !(route.status !== "idle" && route.destination.resource_id === selectedResource.resource_id) ? (
          <PlaceCard resource={selectedResource} now={now} onRoute={requestRoute} onClose={clearSelection} />
        ) : null}
        {selectedEvent && !isDesktop ? (
          <section
            aria-label="Selected alert"
            className="pointer-events-auto flex flex-col gap-2 rounded-2xl bg-hl-panel p-4 shadow-2xl"
          >
            <p className="text-body font-medium text-white">{selectedEvent.headline}</p>
            <p className="text-meta">
              <span className={TONE_TEXT_CLASS[SEVERITY_TONE[selectedEvent.severity]]}>
                {SEVERITY_WORD[selectedEvent.severity]}
              </span>
              <span className="text-hl-muted">
                {" "}
                · {CONFIDENCE_TEXT[selectedEvent.confidence_label]} · {eventTypeLabel(selectedEvent.event_type)} ·{" "}
                {formatAge(selectedEvent.last_verified_at, now)}
              </span>
            </p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setView("alerts")}>
                Read alert
              </Button>
              <Button onClick={clearSelection}>Close</Button>
            </div>
          </section>
        ) : null}
        <RouteBar route={route} onClear={clearRoute} />
      </div>
    </section>
  );
}

export default MapPanel;
