/**
 * Map sources and layers, and the basemap choice.
 *
 * Draw order, bottom to top: basemap, satellite imagery (when on: the daily
 * image below zoom 9, aerial photos from zoom 9), basemap labels, hazard areas, fire-detection footprints, road closures, the route,
 * event points, resource points, icon chips. Fire detections sit below the
 * event points so they never hide an alert.
 */
import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

// --- Basemap ----------------------------------------------------------------

/**
 * Streets: OpenFreeMap's dark style. Keyless, free for any use, attribution
 * required (it ships in the style's TileJSON: OpenFreeMap, OpenMapTiles,
 * OpenStreetMap contributors). Override with NEXT_PUBLIC_BASEMAP_STYLE_URL.
 */
export const BASEMAP_STYLE_URL =
  process.env.NEXT_PUBLIC_BASEMAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/dark";

/** Shown when the basemap style itself cannot load: hazards still draw. */
export const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#0c0c0f" } }],
};

/**
 * Contrast overrides for the dark style, by layer id. The stock style draws
 * minor streets at about 1.1:1 against the background and labels at about
 * 3:1; these lift roads to a readable grid and labels to light grey with a
 * dark halo, while staying neutral so red hazard areas and the teal route
 * remain the strongest colours. Layers that a different style lacks are
 * skipped.
 */
const BASEMAP_PAINT: Record<string, Record<string, unknown>> = {
  water: { "fill-color": "#1a1f27" },
  waterway: { "line-color": "#1f2530" },
  building: { "fill-color": "#141418", "fill-outline-color": "#26262e" },
  highway_path: { "line-color": "#34343c" },
  highway_minor: { "line-color": "#3c3c46" },
  highway_major_casing: { "line-color": "#5c5c68" },
  highway_major_inner: { "line-color": "#2e2e36" },
  highway_major_subtle: { "line-color": "#50505c" },
  highway_motorway_casing: { "line-color": "#6c6c78" },
  highway_motorway_inner: { "line-color": "#34343e" },
  highway_motorway_subtle: { "line-color": "#50505c" },
  railway: { "line-color": "#3a3a42" },
  railway_minor: { "line-color": "#34343c" },
  railway_transit: { "line-color": "#34343c" },
  water_name: { "text-color": "#8b93a1", "text-halo-color": "#0a0a0c", "text-halo-width": 1.2 },
  highway_name_other: { "text-color": "#b4b4be", "text-halo-color": "#0a0a0c", "text-halo-width": 1.5 },
  highway_name_motorway: { "text-color": "#c4c4cc", "text-halo-color": "#0a0a0c", "text-halo-width": 1.5 },
};
const PLACE_LABEL = { "text-color": "#d4d4da", "text-halo-color": "#0a0a0c", "text-halo-width": 1.5 };

export function tuneBasemap(style: StyleSpecification): StyleSpecification {
  return {
    ...style,
    layers: style.layers.map((layer) => {
      const override = BASEMAP_PAINT[layer.id] ?? (layer.id.startsWith("place_") ? PLACE_LABEL : null);
      if (!override || layer.type === "background") return layer;
      return { ...layer, paint: { ...(layer as { paint?: object }).paint, ...override } } as typeof layer;
    }),
  };
}

export async function loadBasemapStyle(): Promise<StyleSpecification | null> {
  try {
    const res = await fetch(BASEMAP_STYLE_URL, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const style = (await res.json()) as StyleSpecification;
    return style && Array.isArray(style.layers) ? tuneBasemap(style) : null;
  } catch {
    return null;
  }
}

// --- Satellite imagery --------------------------------------------------------

/**
 * Two layers share the "satellite" choice, split at this zoom.
 * Below it: the NASA daily image (250 m per pixel, dated, shows smoke).
 * From it: USGS aerial photos (about 1 m per pixel, months to years old).
 * The daily image is too coarse for streets, so it never draws close in.
 */
export const SATELLITE_SPLIT_ZOOM = 9;

/**
 * USGS The National Map orthoimagery (mostly USDA NAIP). United States only.
 * No key, public domain. The cache has tiles to zoom 16.
 */
export const AERIAL_TILE_URL =
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}";
export const AERIAL_MAX_ZOOM = 16;
export const AERIAL_ATTRIBUTION =
  'Aerial photos: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noreferrer">USGS The National Map</a>, USDA';

/**
 * NASA GIBS true-colour imagery, daily mosaic. No key; NASA asks for credit.
 * The best zoom level is 9, which is why it draws only below the split.
 */
export const GIBS_LAYER = "MODIS_Terra_CorrectedReflectance_TrueColor";

export function gibsTileUrl(date: string): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${GIBS_LAYER}/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
}

export const GIBS_ATTRIBUTION =
  'Imagery: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noreferrer">NASA EOSDIS GIBS</a> (MODIS Terra)';

/** Yesterday in UTC, "YYYY-MM-DD": the newest full daily mosaic. */
export function yesterdayUtc(now = new Date()): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

// --- Ids ----------------------------------------------------------------------

export const SRC = {
  hazards: "hl-hazards",
  closures: "hl-closures",
  eventPoints: "hl-event-points",
  eventChips: "hl-event-chips",
  resources: "hl-resources",
  route: "hl-route",
  fire: "hl-fire-detections",
  satellite: "hl-satellite",
  aerial: "hl-aerial",
} as const;

export const LYR = {
  satellite: "hl-satellite",
  aerial: "hl-aerial",
  hazardFill: "hl-hazard-fill",
  hazardCasing: "hl-hazard-casing",
  hazardOutline: "hl-hazard-outline",
  fireFill: "hl-fire-fill",
  fireOutline: "hl-fire-outline",
  closureCasing: "hl-closure-casing",
  closureLine: "hl-closure-line",
  routeCasing: "hl-route-casing",
  routeLine: "hl-route-line",
  eventPoint: "hl-event-point",
  resourcePoint: "hl-resource-point",
  resourceSelected: "hl-resource-selected",
  eventChip: "hl-event-chip",
  resourceChip: "hl-resource-chip",
} as const;

/** Icon chips only at street zooms; below this the dots and fills carry the signal. */
export const CHIP_MIN_ZOOM = 12.3;

export const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

// --- Layer visibility ---------------------------------------------------------

export interface LayerState {
  basemap: "streets" | "satellite";
  satelliteDate: string;
  hazards: boolean;
  closures: boolean;
  shelters: boolean;
  medical: boolean;
  supplies: boolean;
  fire: boolean;
}

export function defaultLayers(): LayerState {
  return {
    basemap: "streets",
    satelliteDate: yesterdayUtc(),
    hazards: true,
    closures: true,
    shelters: true,
    medical: true,
    supplies: true,
    fire: true,
  };
}

/** Resource types each toggle controls. */
export const RESOURCE_GROUPS: Record<"shelters" | "medical" | "supplies", string[]> = {
  shelters: ["shelter"],
  medical: ["hospital"],
  supplies: ["food_water", "charging", "cooling_center", "transport_hub"],
};

// --- Install ------------------------------------------------------------------

/**
 * The basemap's label block: the first symbol layer after its last fill or
 * line layer. Imagery goes just under it, so it covers roads and land but
 * keeps the place and street names readable.
 */
function basemapLabelLayerId(map: MapLibreMap): string | undefined {
  const layers = (map.getStyle().layers ?? []).filter((l) => !l.id.startsWith("hl-"));
  let lastShape = -1;
  layers.forEach((l, i) => {
    if (l.type !== "symbol" && l.type !== "background") lastShape = i;
  });
  return layers.slice(lastShape + 1).find((l) => l.type === "symbol")?.id;
}

export function setSourceData(map: MapLibreMap | null, sourceId: string, data: FeatureCollection): void {
  const source = map?.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data);
}

/**
 * Add (or replace) the two imagery layers under the basemap labels: the daily
 * image for a date below the split zoom, aerial photos from the split zoom.
 */
export function installSatellite(map: MapLibreMap, date: string, visible: boolean): void {
  const visibility = visible ? "visible" : "none";
  const before = basemapLabelLayerId(map) ?? (map.getLayer(LYR.hazardFill) ? LYR.hazardFill : undefined);

  if (map.getLayer(LYR.satellite)) map.removeLayer(LYR.satellite);
  if (map.getSource(SRC.satellite)) map.removeSource(SRC.satellite);
  map.addSource(SRC.satellite, {
    type: "raster",
    tiles: [gibsTileUrl(date)],
    tileSize: 256,
    maxzoom: 9,
    attribution: GIBS_ATTRIBUTION,
  });
  map.addLayer(
    {
      id: LYR.satellite,
      type: "raster",
      source: SRC.satellite,
      maxzoom: SATELLITE_SPLIT_ZOOM,
      layout: { visibility },
    },
    before,
  );

  // The aerial photos do not depend on the date: add them once.
  if (!map.getSource(SRC.aerial)) {
    map.addSource(SRC.aerial, {
      type: "raster",
      tiles: [AERIAL_TILE_URL],
      tileSize: 256,
      maxzoom: AERIAL_MAX_ZOOM,
      attribution: AERIAL_ATTRIBUTION,
    });
  }
  if (!map.getLayer(LYR.aerial)) {
    map.addLayer(
      {
        id: LYR.aerial,
        type: "raster",
        source: SRC.aerial,
        minzoom: SATELLITE_SPLIT_ZOOM,
        layout: { visibility },
      },
      before,
    );
  }
}

export function installOverlayLayers(map: MapLibreMap): void {
  for (const id of [SRC.hazards, SRC.closures, SRC.eventPoints, SRC.eventChips, SRC.resources, SRC.route, SRC.fire]) {
    map.addSource(id, { type: "geojson", data: EMPTY });
  }

  map.addLayer({
    id: LYR.hazardFill,
    type: "fill",
    source: SRC.hazards,
    paint: { "fill-color": ["get", "color"], "fill-opacity": 0.2 },
  });
  // Dark casing keeps hazard edges legible over satellite imagery.
  map.addLayer({
    id: LYR.hazardCasing,
    type: "line",
    source: SRC.hazards,
    paint: { "line-color": "#0a0a0c", "line-width": 5, "line-opacity": 0.7 },
  });
  map.addLayer({
    id: LYR.hazardOutline,
    type: "line",
    source: SRC.hazards,
    paint: { "line-color": ["get", "color"], "line-width": 2 },
  });

  // Fire detections: pixel footprints, coloured by age (newer is brighter).
  map.addLayer({
    id: LYR.fireFill,
    type: "fill",
    source: SRC.fire,
    paint: {
      "fill-color": [
        "step",
        ["get", "age_h"],
        "#fb923c",
        6,
        "#ea580c",
        24,
        "#9a3412",
      ],
      "fill-opacity": 0.55,
    },
  });
  map.addLayer({
    id: LYR.fireOutline,
    type: "line",
    source: SRC.fire,
    paint: { "line-color": "#fed7aa", "line-width": 1, "line-opacity": 0.8 },
  });

  map.addLayer({
    id: LYR.closureCasing,
    type: "line",
    source: SRC.closures,
    layout: { "line-cap": "round" },
    paint: {
      "line-color": "#0a0a0c",
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 14, 9],
      "line-opacity": 0.8,
    },
  });
  map.addLayer({
    id: LYR.closureLine,
    type: "line",
    source: SRC.closures,
    paint: {
      "line-color": "#ef4444",
      "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 4],
      "line-dasharray": [2, 1.5],
    },
  });

  map.addLayer({
    id: LYR.routeCasing,
    type: "line",
    source: SRC.route,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#0a0a0c", "line-width": 9, "line-opacity": 0.8 },
  });
  map.addLayer({
    id: LYR.routeLine,
    type: "line",
    source: SRC.route,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#14b8a6", "line-width": 5 },
  });

  map.addLayer({
    id: LYR.eventPoint,
    type: "circle",
    source: SRC.eventPoints,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 5, 12, 7, 14, 9],
      "circle-color": ["get", "color"],
      "circle-stroke-color": "#0a0a0c",
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: LYR.resourcePoint,
    type: "circle",
    source: SRC.resources,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 5, 12, 8, 14, 12],
      "circle-color": ["get", "color"],
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 11.5, 0.9, 12.5, 0.25],
      "circle-stroke-color": "#0a0a0c",
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: LYR.resourceSelected,
    type: "circle",
    source: SRC.resources,
    filter: ["==", ["get", "resource_id"], ""],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 24],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3,
    },
  });

  map.addLayer({
    id: LYR.resourceChip,
    type: "symbol",
    source: SRC.resources,
    minzoom: CHIP_MIN_ZOOM,
    layout: {
      "icon-image": ["get", "icon"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], CHIP_MIN_ZOOM, 0.8, 14.5, 1],
      "icon-allow-overlap": true,
    },
  });
  map.addLayer({
    id: LYR.eventChip,
    type: "symbol",
    source: SRC.eventChips,
    minzoom: CHIP_MIN_ZOOM,
    layout: {
      "icon-image": ["get", "icon"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], CHIP_MIN_ZOOM, 0.8, 14.5, 1],
      "icon-allow-overlap": true,
    },
  });
}

export const EVENT_CLICK_LAYERS = [LYR.hazardFill, LYR.closureLine, LYR.eventPoint, LYR.eventChip];
export const RESOURCE_CLICK_LAYERS = [LYR.resourcePoint, LYR.resourceChip];

export function applyLayerVisibility(map: MapLibreMap, layers: LayerState): void {
  const vis = (on: boolean) => (on ? "visible" : "none");
  const set = (id: string, on: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis(on));
  };
  for (const id of [LYR.hazardFill, LYR.hazardCasing, LYR.hazardOutline, LYR.eventPoint, LYR.eventChip]) {
    set(id, layers.hazards);
  }
  set(LYR.closureCasing, layers.closures);
  set(LYR.closureLine, layers.closures);
  set(LYR.fireFill, layers.fire);
  set(LYR.fireOutline, layers.fire);
  set(LYR.satellite, layers.basemap === "satellite");
  set(LYR.aerial, layers.basemap === "satellite");

  const types = [
    ...(layers.shelters ? RESOURCE_GROUPS.shelters : []),
    ...(layers.medical ? RESOURCE_GROUPS.medical : []),
    ...(layers.supplies ? RESOURCE_GROUPS.supplies : []),
  ];
  for (const id of [LYR.resourcePoint, LYR.resourceChip, LYR.resourceSelected]) {
    if (!map.getLayer(id)) continue;
    if (id === LYR.resourceSelected) continue;
    map.setFilter(id, ["in", ["get", "resource_type"], ["literal", types]]);
  }
}
