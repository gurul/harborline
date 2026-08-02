import type { BBox, LonLat } from "./geo.js";

/**
 * Everything location-specific the system needs, gathered in one place.
 *
 * Harborline itself is location-agnostic: connectors, the store, routing, the
 * composer, and the UI all read their geography from this config. To point the
 * system at a different area, change `REGION` (and, for the offline demo, the
 * scenario fixtures in `connectors` and the graph in `agent-tools` that share
 * its geography) — no other code refers to a place by name.
 */
export interface RegionConfig {
  /** Human-readable region name used in labels and fallback place names. */
  name: string;
  /** Label for the approximate-location chip, e.g. "Chico centre". */
  centerLabel: string;
  /** Map / geolocation fallback centre. */
  center: LonLat;
  /** Bounding box used to scope live connectors (e.g. USGS earthquakes). */
  bbox: BBox;
  /** `area=` parameter for the NWS active-alerts API (a state code). */
  nwsArea: string;
  /**
   * Accepted spellings of the region's state in shelter feeds, lowercase:
   * postal code, full name, ISO code, and FIPS code.
   */
  stateAliases: string[];
}

/**
 * Active region: California, centred on Chico (Butte County) — the geography
 * the seeded demo scenario uses.
 */
export const REGION: RegionConfig = {
  name: "California",
  centerLabel: "Chico centre",
  center: [-121.8375, 39.7285],
  bbox: [-124.48, 32.53, -114.13, 42.01],
  nwsArea: "CA",
  stateAliases: ["ca", "california", "us-ca", "06"],
};
