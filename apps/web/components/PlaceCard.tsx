"use client";

import type { NearbyResource } from "@harborline/event-schema";
import { RESOURCE_STATUS_TEXT, featureText, formatAge, formatDistance } from "../lib/format";
import { Button, SourceLine } from "./ui";

/** Detail for one place on the map, with the route action. */
export function PlaceCard({
  resource,
  now,
  onRoute,
  onClose,
}: {
  resource: NearbyResource;
  now: Date;
  onRoute: (resource: NearbyResource) => void;
  onClose: () => void;
}) {
  const open = resource.operational_status === "open";
  return (
    <section
      aria-label={`Place: ${resource.name}`}
      className="pointer-events-auto flex max-h-[40dvh] flex-col gap-2 overflow-y-auto rounded-2xl bg-hl-panel p-4 shadow-2xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-body font-medium text-white">{resource.name}</h2>
          <p className="text-meta text-white">
            <span className={open ? "text-hl-ok" : "text-hl-muted"}>
              {RESOURCE_STATUS_TEXT[resource.operational_status]}
            </span>
            <span className="text-hl-muted"> · </span>
            {formatDistance(resource.distance_m)}
            {resource.capacity_available !== null && resource.capacity_total !== null
              ? ` · ${resource.capacity_available} of ${resource.capacity_total} free`
              : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close place details"
          className="-m-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-body text-white hover:bg-hl-raised"
        >
          ✕
        </button>
      </div>

      {resource.address ? <p className="text-meta text-white">{resource.address}</p> : null}
      {resource.accessibility_features.length > 0 ? (
        <p className="text-meta text-white">
          {resource.accessibility_features.map(featureText).join(" · ")}
        </p>
      ) : null}
      {resource.pet_policy ? (
        <p className="text-meta text-white">
          {/pet/i.test(resource.pet_policy) ? resource.pet_policy : `Pets: ${resource.pet_policy}`}
        </p>
      ) : null}
      {resource.health_advisory ? (
        <p className="text-meta text-hl-moderate">Health advisory: {resource.health_advisory}</p>
      ) : null}
      {resource.contact_information ? (
        <p className="text-meta text-white">
          Contact:{" "}
          {/^[+()\d\s.-]{7,}$/.test(resource.contact_information) ? (
            <a
              className="underline underline-offset-4"
              href={`tel:${resource.contact_information.replace(/[^\d+]/g, "")}`}
            >
              {resource.contact_information}
            </a>
          ) : (
            resource.contact_information
          )}
        </p>
      ) : null}
      <SourceLine>
        Verified {formatAge(resource.last_verified_at, now)} · {resource.provider} · tier{" "}
        {resource.provider_tier}
      </SourceLine>

      {resource.resource_type === "shelter" ? (
        <div className="mt-1">
          <Button variant="action" onClick={() => onRoute(resource)}>
            Route here
          </Button>
        </div>
      ) : null}
    </section>
  );
}
