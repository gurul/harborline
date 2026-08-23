import { z } from "zod";
import {
  REGION,
  ResourceSchema,
  type Connector,
  type ConnectorResult,
  type OperationalStatus,
  type Resource,
} from "@harborline/event-schema";
import { errorMessage, fetchJson, hashContent, stableStringify, toIso } from "./util.js";

export const FEMA_SHELTERS_URL =
  "https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson";

const FemaFeatureSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).nullish(),
  properties: z.record(z.string(), z.unknown()).nullish(),
  attributes: z.record(z.string(), z.unknown()).nullish(),
  geometry: z
    .looseObject({
      type: z.string().nullish(),
      coordinates: z.array(z.number()).nullish(),
      x: z.number().nullish(),
      y: z.number().nullish(),
    })
    .nullish(),
});

const FemaFeatureCollectionSchema = z.looseObject({
  features: z.array(FemaFeatureSchema).nullish(),
  error: z.unknown().optional(),
});

type Attributes = Record<string, unknown>;

/** Normalize a key for fuzzy matching: lowercase, strip non-alphanumerics. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * ArcGIS layers rename columns between refreshes, so every read probes several
 * spellings rather than assuming one.
 */
export function pickAttribute(attrs: Attributes, candidates: string[]): unknown {
  const index = new Map<string, unknown>();
  for (const [key, value] of Object.entries(attrs)) {
    const norm = normalizeKey(key);
    if (!index.has(norm)) index.set(norm, value);
  }
  for (const candidate of candidates) {
    const value = index.get(normalizeKey(candidate));
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function pickString(attrs: Attributes, candidates: string[]): string | null {
  const value = pickAttribute(attrs, candidates);
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function pickNumber(attrs: Attributes, candidates: string[]): number | null {
  const value = pickAttribute(attrs, candidates);
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Case-insensitive substring match on whatever the layer calls "status". */
export function mapShelterStatus(raw: string | null): OperationalStatus {
  if (!raw) return "unknown";
  const v = raw.toLowerCase();
  if (v.includes("full")) return "full";
  if (v.includes("closed")) return "closed";
  if (v.includes("open")) return "open";
  return "unknown";
}

const STATUS_KEYS = [
  "shelter_status",
  "shelter_status_code",
  "status",
  "shelterstatus",
  "operational_status",
  "open_closed",
];

const UPDATED_KEYS = [
  "last_updated",
  "last_updated_date",
  "lastupdate",
  "last_update",
  "updated",
  "updated_date",
  "update_date",
  "date_updated",
  "edit_date",
  "editdate",
  "last_edited_date",
  "last_edited",
  "report_date",
  "as_of_date",
  "timestamp",
];

const STATE_KEYS = ["state", "shelter_state", "st", "state_abbr", "statecode", "state_name"];

function isRegionState(value: string | null): boolean {
  if (!value) return false;
  return REGION.stateAliases.includes(value.trim().toLowerCase());
}

function buildAddress(attrs: Attributes): string | null {
  const parts = [
    pickString(attrs, ["address", "address_1", "street_address", "shelter_address"]),
    pickString(attrs, ["city", "shelter_city"]),
    pickString(attrs, STATE_KEYS),
    pickString(attrs, ["zip", "zip_code", "postal_code", "zipcode"]),
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

function accessibilityFeatures(attrs: Attributes): string[] {
  const features: string[] = [];
  const wheelchair = pickString(attrs, [
    "wheelchair_accessible",
    "ada_compliant",
    "ada",
    "handicap_accessible",
    "accessibility",
  ]);
  if (wheelchair && /^(y|yes|true|1|ada|accessible)/i.test(wheelchair)) {
    features.push("wheelchair_accessible");
  }
  return features;
}

/**
 * ArcGIS layers occasionally serve Web Mercator meters (or plain garbage) in a
 * field that is nominally lon/lat. Validated here rather than downstream so an
 * out-of-range coordinate skips one shelter instead of throwing on parse.
 */
function asLonLat(lon: unknown, lat: unknown): { lon: number; lat: number } | null {
  if (typeof lon !== "number" || typeof lat !== "number") return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return { lon, lat };
}

function coordinatesOf(feature: z.infer<typeof FemaFeatureSchema>, attrs: Attributes) {
  const coords = feature.geometry?.coordinates;
  if (coords && coords.length >= 2) {
    return asLonLat(coords[0], coords[1]);
  }
  const x = feature.geometry?.x;
  const y = feature.geometry?.y;
  if (typeof x === "number" && typeof y === "number") return asLonLat(x, y);
  const lon = pickNumber(attrs, ["longitude", "lon", "x", "long"]);
  const lat = pickNumber(attrs, ["latitude", "lat", "y"]);
  if (lon !== null && lat !== null) return asLonLat(lon, lat);
  return null;
}

export const femaSheltersConnector: Connector = {
  id: "fema-shelters",
  label: "FEMA National Shelter System — open shelters",
  source_tier: "B",
  expected_refresh_seconds: 1800,

  async fetch(now: Date): Promise<ConnectorResult> {
    const retrieved_at = now.toISOString();
    try {
      const payload = await fetchJson(FEMA_SHELTERS_URL, {
        headers: { Accept: "application/geo+json, application/json" },
        timeoutMs: 10_000,
      });

      const parsed = FemaFeatureCollectionSchema.safeParse(payload);
      if (!parsed.success) {
        return {
          ok: false,
          retrieved_at,
          error: `unexpected FEMA payload shape: ${parsed.error.message}`,
        };
      }
      if (parsed.data.error !== undefined) {
        return {
          ok: false,
          retrieved_at,
          error: `FEMA service error: ${stableStringify(parsed.data.error)}`,
        };
      }

      const features = parsed.data.features ?? [];
      const resources: Resource[] = [];

      for (const feature of features) {
        const attrs: Attributes = {
          ...(feature.attributes ?? {}),
          ...(feature.properties ?? {}),
        };

        // Only filter by state when the layer actually carries one.
        const state = pickString(attrs, STATE_KEYS);
        if (state !== null && !isRegionState(state)) continue;

        const point = coordinatesOf(feature, attrs);
        if (!point) continue;

        // Honest freshness: prefer the record's own update stamp. The layer's
        // current schema carries no date column at all (audited 2026-08-23:
        // 22 fields, editingInfo/timeInfo null), which used to drop every
        // record. This is FEMA's live *open shelters* roster — a shelter is
        // only present while open — so the poll time is an honest fallback:
        // presence in this fetch is itself the verification.
        const lastVerifiedAt =
          toIso(pickAttribute(attrs, UPDATED_KEYS)) ?? retrieved_at;

        const idSource =
          pickString(attrs, ["shelter_id", "objectid", "id", "globalid"]) ??
          (feature.id != null ? String(feature.id) : null) ??
          hashContent(stableStringify(feature));

        const capacityTotal = pickNumber(attrs, [
          "evacuation_capacity",
          "capacity",
          "total_capacity",
          "shelter_capacity",
          "max_capacity",
        ]);
        const population = pickNumber(attrs, [
          "population",
          "current_population",
          "total_population",
          "occupancy",
        ]);
        const capacityAvailable =
          capacityTotal !== null && population !== null
            ? Math.max(0, capacityTotal - population)
            : null;

        const candidate: Resource = {
          resource_id: `fema:${idSource}`,
          resource_type: "shelter",
          name:
            pickString(attrs, ["shelter_name", "name", "facility_name", "site_name"]) ??
            "Unnamed shelter",
          location: { type: "Point", coordinates: [point.lon, point.lat] },
          address: buildAddress(attrs),
          operational_status: mapShelterStatus(pickString(attrs, STATUS_KEYS)),
          capacity_total: capacityTotal,
          capacity_available: capacityAvailable,
          accessibility_features: accessibilityFeatures(attrs),
          // The NSS layer carries no health-status column; advisories would
          // come from a public-health source, not this feed.
          health_advisory: null,
          pet_policy: pickString(attrs, [
            "pet_accommodations",
            "pet_friendly",
            "pets",
            "pet_policy",
          ]),
          contact_information: pickString(attrs, [
            "phone",
            "shelter_phone",
            "contact_phone",
            "telephone",
          ]),
          last_verified_at: lastVerifiedAt,
          provider: "FEMA NSS",
          provider_tier: "B",
          source_url: FEMA_SHELTERS_URL,
        };

        const validated = ResourceSchema.safeParse(candidate);
        if (validated.success) resources.push(validated.data);
      }

      return { ok: true, retrieved_at, events: [], resources, source_records: [] };
    } catch (err) {
      return { ok: false, retrieved_at, error: errorMessage(err) };
    }
  },
};
