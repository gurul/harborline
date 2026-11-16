"use client";

import { useMemo } from "react";
import {
  SEVERITY_RANK,
  eventMaxAge,
  isStale,
  type CanonicalEvent,
  type NearbyResource,
  type Severity,
} from "@harborline/event-schema";
import type {
  AirQualityReading,
  EnvironmentResult,
  FloodCategory,
  GaugeReading,
} from "../lib/api";
import {
  RESOURCE_STATUS_TEXT,
  SEVERITY_TONE,
  compassDirection,
  featureText,
  formatAge,
  formatClock,
  formatDistance,
  provenanceLine,
  useNow,
  type Tone,
} from "../lib/format";
import { rankShelters, EXCLUSION_TEXT, type ShelterRanking } from "../lib/ranking";
import { useEnvironment, useResources } from "../lib/queries";
import { useLiveFeed } from "../lib/useLiveFeed";
import { useAppState } from "./AppState";
import { usePreferences } from "./Preferences";
import { StatusTile, type StatusTileProps } from "./StatusTile";
import { Button, SectionHeading, SourceLine } from "./ui";

const RESOURCE_TYPE_TEXT: Record<string, string> = {
  shelter: "Shelter",
  hospital: "Hospital",
  cooling_center: "Cooling centre",
  food_water: "Food and water",
  charging: "Charging point",
  transport_hub: "Transport hub",
};

/** Readings older than this are stale even if the server says "ok". */
const AIR_MAX_AGE_S = 3 * 3600;
const GAUGE_MAX_AGE_S = 2 * 3600;

export function NowView() {
  const { user, requestRoute, select, ask, setView, focusFire, route } = useAppState();
  const { preferences } = usePreferences();
  const now = useNow(30_000);

  const feed = useLiveFeed({ lat: user.lat, lon: user.lon });
  const resourcesQuery = useResources(user.lat, user.lon);
  const environment = useEnvironment(user.lat, user.lon);

  const resources = useMemo(() => resourcesQuery.data?.resources ?? [], [resourcesQuery.data]);
  const ranking = useMemo(
    () => rankShelters(resources, feed.events, preferences.needs, now),
    [resources, feed.events, preferences.needs, now],
  );
  const otherPlaces = useMemo(() => {
    const others = resources.filter((r) => r.resource_type !== "shelter");
    // Power need: charging points first.
    if (preferences.needs.includes("medical_power")) {
      others.sort(
        (a, b) =>
          Number(b.resource_type === "charging") - Number(a.resource_type === "charging") ||
          a.distance_m - b.distance_m,
      );
    } else {
      others.sort((a, b) => a.distance_m - b.distance_m);
    }
    return others;
  }, [resources, preferences.needs]);

  const userPoint: [number, number] = [user.lon, user.lat];
  const routedId = route.status !== "idle" ? route.destination.resource_id : null;

  return (
    <div className="flex flex-col gap-5">
      <NearestShelterCard
        ranking={ranking}
        state={
          resourcesQuery.isPending
            ? "loading"
            : resourcesQuery.isError && !resourcesQuery.data
              ? "error"
              : "ready"
        }
        refreshFailedAt={
          resourcesQuery.isError && resourcesQuery.data ? resourcesQuery.dataUpdatedAt : null
        }
        userPoint={userPoint}
        now={now}
        onRoute={requestRoute}
        onShowOnMap={(r) => select({ kind: "resource", id: r.resource_id }, { revealMap: true })}
        onRetry={() => void resourcesQuery.refetch()}
        onAsk={() => ask("Where should I go right now?")}
      />

      <section aria-labelledby="tiles-heading" className="flex flex-col gap-3">
        <SectionHeading id="tiles-heading">Conditions near you</SectionHeading>
        <div className="grid grid-cols-2 gap-3 lg:gap-4">
          <StatusTile
            {...alertsTile(feed, now)}
            action={{ label: "Open alerts", onClick: () => setView("alerts") }}
          />
          <StatusTile
            {...fireTile(environment, feed.events, now)}
            action={
              environment.data?.kind === "ok" && (environment.data.data.fire?.detections ?? 0) > 0
                ? { label: "Show on map", onClick: focusFire }
                : undefined
            }
          />
          <StatusTile {...airTile(environment, now)} />
          <StatusTile {...gaugeTile(environment, now)} />
          <StatusTile {...powerTile(environment, feed.events)} wide />
        </div>
      </section>

      <PlaceList
        title="Shelters"
        headingId="shelters-heading"
        places={[...ranking.eligible, ...ranking.excluded.map((e) => e.resource)]}
        excluded={new Map(ranking.excluded.map((e) => [e.resource.resource_id, EXCLUSION_TEXT[e.reason]]))}
        state={resourcesQuery.isPending ? "loading" : resourcesQuery.isError && !resourcesQuery.data ? "error" : "ready"}
        now={now}
        routedId={routedId}
        onRoute={requestRoute}
        onShowOnMap={(r) => select({ kind: "resource", id: r.resource_id }, { revealMap: true })}
        emptyText="No shelters are listed within 8 km."
      />

      {otherPlaces.length > 0 ? (
        <PlaceList
          title="Other places"
          headingId="places-heading"
          places={otherPlaces}
          excluded={new Map()}
          state="ready"
          now={now}
          routedId={routedId}
          onShowOnMap={(r) => select({ kind: "resource", id: r.resource_id }, { revealMap: true })}
          emptyText=""
        />
      ) : null}
    </div>
  );
}

// --- Hero ---------------------------------------------------------------------

function capacityText(r: NearbyResource): string {
  if (r.capacity_available !== null && r.capacity_total !== null) {
    return `${r.capacity_available} of ${r.capacity_total} places free`;
  }
  return "Capacity not reported";
}

function NearestShelterCard({
  ranking,
  state,
  refreshFailedAt,
  userPoint,
  now,
  onRoute,
  onShowOnMap,
  onRetry,
  onAsk,
}: {
  ranking: ShelterRanking;
  state: "loading" | "error" | "ready";
  refreshFailedAt: number | null;
  userPoint: [number, number];
  now: Date;
  onRoute: (r: NearbyResource) => void;
  onShowOnMap: (r: NearbyResource) => void;
  onRetry: () => void;
  onAsk: () => void;
}) {
  const shelter = ranking.recommended;

  return (
    <section
      aria-labelledby="hero-heading"
      aria-busy={state === "loading" || undefined}
      className="rounded-2xl bg-hl-panel p-4"
    >
      <h2 id="hero-heading" className="text-meta font-medium text-hl-muted">
        Nearest open shelter
      </h2>

      {state === "loading" ? (
        <div className="mt-2 flex flex-col gap-2" aria-hidden="true">
          <span className="block h-7 w-2/3 rounded-md bg-hl-raised" />
          <span className="block h-4 w-1/2 rounded-md bg-hl-raised" />
          <p className="text-meta text-hl-muted">Loading shelters…</p>
        </div>
      ) : state === "error" ? (
        <div className="mt-2 flex flex-col gap-3">
          <p className="text-value font-semibold text-hl-moderate">Could not load shelters</p>
          <p className="text-body text-white">
            No shelter can be recommended until the list loads. Do not read this as “no shelter
            exists”.
          </p>
          <div>
            <Button onClick={onRetry}>Try again</Button>
          </div>
        </div>
      ) : !shelter ? (
        <div className="mt-2 flex flex-col gap-3">
          <p className="text-value font-semibold text-white">None verified nearby</p>
          <p className="text-body text-white">
            No open shelter with a current, verified status is listed within 8 km.
          </p>
          <div>
            <Button variant="primary" onClick={onAsk}>
              Ask what to do
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1 flex flex-col gap-1">
          <p className="text-value font-semibold text-white">{shelter.name}</p>
          <p className="text-body text-white">
            {formatDistance(shelter.distance_m)}{" "}
            {compassDirection(userPoint, shelter.location.coordinates as [number, number])}
            <span className="text-hl-muted"> · </span>
            <span className="text-hl-ok">{RESOURCE_STATUS_TEXT[shelter.operational_status]}</span>
            <span className="text-hl-muted"> · </span>
            {capacityText(shelter)}
          </p>
          {shelter.accessibility_features.length > 0 || shelter.pet_policy ? (
            <p className="text-meta text-white">
              {[
                ...shelter.accessibility_features.map(featureText),
                shelter.pet_policy
                  ? /pet/i.test(shelter.pet_policy)
                    ? shelter.pet_policy
                    : `Pets: ${shelter.pet_policy}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {shelter.health_advisory ? (
            <p className="text-meta text-hl-moderate">Health advisory: {shelter.health_advisory}</p>
          ) : null}
          <SourceLine>
            Verified {formatAge(shelter.last_verified_at, now)} · {shelter.provider} · tier{" "}
            {shelter.provider_tier}
          </SourceLine>
          {refreshFailedAt ? (
            <SourceLine warn>
              Could not refresh the shelter list. Showing data from {formatClock(refreshFailedAt)}.
            </SourceLine>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="action" onClick={() => onRoute(shelter)}>
              Route here
            </Button>
            <Button onClick={() => onShowOnMap(shelter)}>On map</Button>
          </div>
        </div>
      )}

      {state === "ready" && ranking.excluded.length > 0 ? (
        <details className="mt-3 text-meta text-hl-muted">
          <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg text-white">
            {ranking.excluded.length} other {ranking.excluded.length === 1 ? "shelter" : "shelters"} left
            out
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {ranking.excluded.map(({ resource, reason }) => (
              <li key={resource.resource_id}>
                <span className="text-white">{resource.name}</span>: {EXCLUSION_TEXT[reason]} (
                {formatAge(resource.last_verified_at, now)})
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

// --- Place lists ---------------------------------------------------------------

function PlaceList({
  title,
  headingId,
  places,
  excluded,
  state,
  now,
  routedId,
  onRoute,
  onShowOnMap,
  emptyText,
}: {
  title: string;
  headingId: string;
  places: NearbyResource[];
  excluded: Map<string, string>;
  state: "loading" | "error" | "ready";
  now: Date;
  routedId: string | null;
  onRoute?: (r: NearbyResource) => void;
  onShowOnMap: (r: NearbyResource) => void;
  emptyText: string;
}) {
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading id={headingId}>{title}</SectionHeading>
      {state === "loading" ? (
        <p className="text-meta text-hl-muted">Loading…</p>
      ) : state === "error" ? (
        <p className="text-meta text-hl-moderate">Could not load places.</p>
      ) : places.length === 0 ? (
        <p className="text-meta text-hl-muted">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {places.map((place) => {
            const reason = excluded.get(place.resource_id);
            const statusTone =
              place.operational_status === "open" && !reason ? "text-hl-ok" : "text-hl-muted";
            return (
              <li key={place.resource_id} className="rounded-2xl bg-hl-panel p-4">
                <p className="text-body font-medium text-white">{place.name}</p>
                <p className="text-meta text-white">
                  {RESOURCE_TYPE_TEXT[place.resource_type] ?? place.resource_type}
                  <span className="text-hl-muted"> · </span>
                  <span className={statusTone}>{RESOURCE_STATUS_TEXT[place.operational_status]}</span>
                  <span className="text-hl-muted"> · </span>
                  {formatDistance(place.distance_m)}
                </p>
                {reason ? <p className="text-meta text-hl-moderate">Left out: {reason}</p> : null}
                <SourceLine>
                  Verified {formatAge(place.last_verified_at, now)} · {place.provider}
                </SourceLine>
                <div className="mt-2 flex flex-wrap gap-2">
                  {onRoute ? (
                    <Button
                      variant={routedId === place.resource_id ? "secondary" : "secondary"}
                      onClick={() => onRoute(place)}
                      aria-label={`Route here: ${place.name}`}
                    >
                      {routedId === place.resource_id ? "Route shown" : "Route here"}
                    </Button>
                  ) : null}
                  <Button onClick={() => onShowOnMap(place)} aria-label={`Show ${place.name} on the map`}>
                    On map
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// --- Tile builders ---------------------------------------------------------------

type TileModel = Omit<StatusTileProps, "action">;
type FeedLike = ReturnType<typeof useLiveFeed>;
type EnvQuery = ReturnType<typeof useEnvironment>;

function alertsTile(feed: FeedLike, now: Date): TileModel {
  const label = "Alerts";
  if (feed.isLoading) return { label, state: "loading" };
  if (feed.isError && !feed.hasData) {
    return {
      label,
      state: "error",
      detail: "Do not read this as all-clear.",
    };
  }
  const active = feed.events.filter((e) => e.status === "active");
  const fresh = active.filter((e) => !isStale(e.last_verified_at, eventMaxAge(e.event_type), now));
  const notReverified = active.length - fresh.length;
  const updated = feed.updatedAt ? `Feed updated ${formatAge(new Date(feed.updatedAt).toISOString(), now)}` : undefined;
  const refreshWarning =
    feed.isError && feed.updatedAt
      ? `Could not refresh. Last data from ${formatClock(feed.updatedAt)}.`
      : undefined;

  if (fresh.length === 0) {
    return {
      label,
      state: feed.isError ? "error" : "empty",
      value: feed.isError ? undefined : "None active",
      detail:
        notReverified > 0
          ? `${notReverified} not re-verified recently`
          : "No active alerts within 8 km.",
      source: updated,
      warning: refreshWarning,
    };
  }
  const counts = new Map<Severity, number>();
  for (const e of fresh) counts.set(e.severity, (counts.get(e.severity) ?? 0) + 1);
  const order = (Object.keys(SEVERITY_RANK) as Severity[]).sort(
    (a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a],
  );
  const present = order.filter((s) => counts.get(s));
  const top = present[0] as Severity;
  const rest = present
    .slice(1)
    .map((s) => `${counts.get(s)} ${s}`)
    .join(", ");
  return {
    label,
    state: feed.isError ? "stale" : "ok",
    value: `${counts.get(top)} ${top}`,
    tone: SEVERITY_TONE[top],
    detail: [rest, notReverified > 0 ? `${notReverified} not re-verified` : ""].filter(Boolean).join(" · ") || `${fresh.length} active within 8 km`,
    source: updated,
    warning: refreshWarning,
  };
}

/** Common handling of the environment read: loading, not connected, error. */
function envGate(
  env: EnvQuery,
  label: string,
): { gate: TileModel } | { result: Extract<EnvironmentResult, { kind: "ok" }>; failed: boolean } {
  if (env.isPending) return { gate: { label, state: "loading" } };
  if (!env.data) {
    return {
      gate: {
        label,
        state: "error",
        detail: "The environment service did not answer.",
        warning: "Retrying automatically.",
      },
    };
  }
  if (env.data.kind === "not_connected") {
    return {
      gate: { label, state: "not_connected", detail: "No source connected for this area." },
    };
  }
  return { result: env.data, failed: env.isError };
}

function failedWarning(env: EnvQuery): string {
  return `Could not refresh. Last value from ${formatClock(env.dataUpdatedAt)}.`;
}

function aqiTone(aqi: number): Tone {
  if (aqi <= 50) return "ok";
  if (aqi <= 100) return "minor";
  if (aqi <= 150) return "moderate";
  if (aqi <= 200) return "severe";
  return "extreme";
}

function readingAge(r: { last_verified_at: string | null }, maxAgeS: number, now: Date): boolean {
  return r.last_verified_at ? isStale(r.last_verified_at, maxAgeS, now) : false;
}

function airTile(env: EnvQuery, now: Date): TileModel {
  const label = "Air quality";
  const gated = envGate(env, label);
  if ("gate" in gated) return gated.gate;
  const reading: AirQualityReading | null = gated.result.data.air_quality;
  if (!reading) return { label, state: "not_connected", detail: "No source connected for this area." };
  const source = provenanceLine(
    { provider: reading.provider, tier: reading.provider_tier, at: reading.last_verified_at, ageLabel: reading.age_label },
    now,
  );
  if (reading.status === "no_data" || reading.aqi === null) {
    return { label, state: "empty", value: "No reading", detail: "No station reporting nearby.", source };
  }
  const where = [reading.name, reading.distance_m !== null ? formatDistance(reading.distance_m) : null]
    .filter(Boolean)
    .join(", ");
  const detail = [reading.category, reading.pollutant].filter(Boolean).join(" · ") + (where ? ` · ${where}` : "");
  const stale = reading.status === "stale" || readingAge(reading, AIR_MAX_AGE_S, now);
  if (gated.failed) {
    return { label, state: "error", value: `AQI ${reading.aqi}`, detail, source, warning: failedWarning(env) };
  }
  return {
    label,
    state: stale ? "stale" : "ok",
    value: `AQI ${reading.aqi}`,
    tone: aqiTone(reading.aqi),
    detail,
    source,
    warning: "Not re-verified recently.",
  };
}

const FLOOD_TEXT: Record<FloodCategory, { text: string; tone: Tone }> = {
  no_flooding: { text: "Below flood stage", tone: "ok" },
  action: { text: "Action stage", tone: "minor" },
  minor: { text: "Minor flooding", tone: "moderate" },
  moderate: { text: "Moderate flooding", tone: "severe" },
  major: { text: "Major flooding", tone: "extreme" },
  unknown: { text: "Flood stage unknown", tone: "neutral" },
};

function gaugeTile(env: EnvQuery, now: Date): TileModel {
  const label = "River gauge";
  const gated = envGate(env, label);
  if ("gate" in gated) return gated.gate;
  const reading: GaugeReading | null = gated.result.data.stream_gauge;
  if (!reading) return { label, state: "not_connected", detail: "No source connected for this area." };
  const source = provenanceLine(
    { provider: reading.provider, tier: reading.provider_tier, at: reading.last_verified_at, ageLabel: reading.age_label },
    now,
  );
  if (reading.status === "no_data" || reading.stage_ft === null) {
    return { label, state: "empty", value: "No reading", detail: "No gauge reporting nearby.", source };
  }
  const category = FLOOD_TEXT[reading.flood_category ?? "unknown"];
  const detail = [
    category.text,
    reading.forecast_category ? `forecast ${reading.forecast_category.replace(/_/g, " ")}` : null,
    reading.name,
  ]
    .filter(Boolean)
    .join(" · ");
  const value = `${reading.stage_ft.toFixed(1)} ft`;
  if (gated.failed) {
    return { label, state: "error", value, detail, source, warning: failedWarning(env) };
  }
  const stale = reading.status === "stale" || readingAge(reading, GAUGE_MAX_AGE_S, now);
  return {
    label,
    state: stale ? "stale" : "ok",
    value,
    tone: category.tone,
    detail,
    source,
    warning: "Not re-verified recently.",
  };
}

function fireTile(env: EnvQuery, events: CanonicalEvent[], now: Date): TileModel {
  const label = "Fire near you";
  // Active, current fire alerts and perimeters from the event feed.
  const fireAlerts = events.filter(
    (e) =>
      e.status === "active" &&
      (e.event_type === "fire" || e.event_type === "fire_perimeter") &&
      !isStale(e.last_verified_at, eventMaxAge(e.event_type), now),
  );
  const topSeverity = fireAlerts.reduce<Severity | null>(
    (top, e) => (!top || SEVERITY_RANK[e.severity] > SEVERITY_RANK[top] ? e.severity : top),
    null,
  );
  const alertHeadline =
    fireAlerts.length > 0
      ? `${fireAlerts.length} fire ${fireAlerts.length === 1 ? "alert" : "alerts"}`
      : null;

  const gated = envGate(env, label);
  if ("gate" in gated) {
    // The satellite read is missing, but a fire alert is a fact: lead with it.
    if (alertHeadline && topSeverity) {
      return {
        label,
        state: "ok",
        value: alertHeadline,
        tone: SEVERITY_TONE[topSeverity],
        detail:
          gated.gate.state === "loading"
            ? "Satellite detections loading."
            : gated.gate.state === "not_connected"
              ? "No satellite detection source connected."
              : "Satellite detections could not load.",
        source: "From official and reported alerts",
      };
    }
    return gated.gate;
  }

  const fire = gated.result.data.fire;
  const failed = gated.failed ? failedWarning(env) : undefined;
  if (!fire) {
    if (alertHeadline && topSeverity) {
      return {
        label,
        state: "ok",
        value: alertHeadline,
        tone: SEVERITY_TONE[topSeverity],
        detail: "No satellite detection source connected.",
        source: "From official and reported alerts",
      };
    }
    return { label, state: "not_connected", detail: "No satellite detection source connected." };
  }

  const age = fire.newest_observed_at ? formatAge(fire.newest_observed_at, now) : fire.newest_age_label;
  const satelliteSource = ["Satellite heat detections", age ? `newest ${age}` : null]
    .filter(Boolean)
    .join(" · ");
  const missingData = fire.status === "no_data";
  const detectionsLine = missingData
    ? "Satellite detection data is missing."
    : `${fire.detections} satellite ${fire.detections === 1 ? "detection" : "detections"} in the last 24 h`;

  if (fire.detections === 0 || missingData) {
    const perimeterHeadline =
      fire.perimeters > 0
        ? `${fire.perimeters} fire ${fire.perimeters === 1 ? "perimeter" : "perimeters"}`
        : null;
    if (alertHeadline || perimeterHeadline) {
      return {
        label,
        state: failed ? "stale" : "ok",
        value: alertHeadline ?? perimeterHeadline ?? undefined,
        tone: topSeverity ? SEVERITY_TONE[topSeverity] : "moderate",
        detail: detectionsLine,
        source: fire.note ?? satelliteSource,
        warning: failed,
      };
    }
    return {
      label,
      state: failed ? "error" : "empty",
      value: missingData ? "Satellite data missing" : "0 satellite detections",
      detail: fire.note ?? "A satellite may miss a fire under cloud or smoke.",
      source: satelliteSource,
      warning: failed,
    };
  }

  const nearest =
    fire.nearest_distance_m !== null ? `nearest ${formatDistance(fire.nearest_distance_m)}` : null;
  const detail = [
    nearest,
    fire.confirmed ? "confirmed by a fire agency" : "not confirmed by a fire agency",
    alertHeadline ? `${alertHeadline} in Alerts` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    label,
    state: failed ? "stale" : "ok",
    value: `${fire.detections} satellite ${fire.detections === 1 ? "detection" : "detections"}`,
    tone: topSeverity ? SEVERITY_TONE[topSeverity] : "moderate",
    detail,
    source: fire.note ? `${satelliteSource} · ${fire.note}` : satelliteSource,
    warning: failed,
  };
}

function powerTile(env: EnvQuery, events: CanonicalEvent[]): TileModel {
  const label = "Power";
  const outageAlerts = events.filter((e) => e.status === "active" && e.event_type === "power_outage").length;
  const alertNote =
    outageAlerts > 0 ? ` ${outageAlerts} outage ${outageAlerts === 1 ? "alert is" : "alerts are"} in Alerts.` : "";
  if (env.isPending) return { label, state: "loading" };
  const power = env.data?.kind === "ok" ? env.data.data.power : null;
  if (power?.status === "outage_reported") {
    return {
      label,
      state: env.isError ? "error" : "ok",
      value: "Outage reported",
      tone: "moderate",
      detail: (power.note ?? "") + alertNote,
      warning: env.isError ? failedWarning(env) : undefined,
    };
  }
  // Absence of an outage report is not a fact: never "normal".
  return {
    label,
    state: "not_connected",
    value: "Not monitored",
    detail:
      (power?.note ?? "No utility outage feed is connected, so no report does not mean power is on.") +
      alertNote,
  };
}
