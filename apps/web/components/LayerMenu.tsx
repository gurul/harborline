"use client";

import { useEffect, useId, useRef, useState } from "react";
import { yesterdayUtc, type LayerState } from "../lib/mapLayers";

type ToggleKey = "hazards" | "closures" | "shelters" | "medical" | "supplies" | "fire";

const TOGGLES: { key: ToggleKey; label: string }[] = [
  { key: "hazards", label: "Hazard areas and alerts" },
  { key: "closures", label: "Road closures" },
  { key: "fire", label: "Satellite fire detections" },
  { key: "shelters", label: "Shelters" },
  { key: "medical", label: "Hospitals" },
  { key: "supplies", label: "Food, water, charging, transport" },
];

/** One "Layers" button in place of chip rows. */
export function LayerMenu({
  layers,
  onChange,
  fireStatus,
}: {
  layers: LayerState;
  onChange: (next: LayerState) => void;
  fireStatus: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const maxDate = yesterdayUtc();

  return (
    <div className="pointer-events-auto relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-hl-control-edge bg-hl-panel/95 px-4 text-meta font-medium text-white shadow-lg hover:bg-hl-raised"
      >
        Layers
        <span aria-hidden="true" className="text-hl-muted">
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          className="absolute top-full left-0 z-30 mt-2 flex max-h-[60dvh] w-72 flex-col gap-3 overflow-y-auto rounded-2xl bg-hl-panel p-4 shadow-2xl"
        >
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-meta font-medium text-hl-muted">Base map</legend>
            {(["streets", "satellite"] as const).map((kind) => (
              <label key={kind} className="flex min-h-11 cursor-pointer items-center gap-3 text-body text-white">
                <input
                  type="radio"
                  name={`${panelId}-basemap`}
                  checked={layers.basemap === kind}
                  onChange={() => onChange({ ...layers, basemap: kind })}
                  className="h-5 w-5 accent-hl-teal"
                />
                {kind === "streets" ? "Streets" : "Satellite and aerial imagery (not live)"}
              </label>
            ))}
            {layers.basemap === "satellite" ? (
              <label className="mt-1 flex flex-col gap-1 text-meta text-hl-muted">
                Daily satellite image date (UTC). Zoom out to see it. Close in, the map shows aerial photos that are not current.
                <input
                  type="date"
                  value={layers.satelliteDate}
                  max={maxDate}
                  min="2012-01-01"
                  onChange={(e) => {
                    if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && e.target.value <= maxDate) {
                      onChange({ ...layers, satelliteDate: e.target.value });
                    }
                  }}
                  className="min-h-11 rounded-lg border border-hl-control-edge bg-hl-raised px-3 text-body text-white [color-scheme:dark]"
                />
              </label>
            ) : null}
          </fieldset>

          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-meta font-medium text-hl-muted">Show</legend>
            {TOGGLES.map((t) => (
              <label key={t.key} className="flex min-h-11 cursor-pointer items-center gap-3 text-body text-white">
                <input
                  type="checkbox"
                  checked={layers[t.key]}
                  onChange={(e) => onChange({ ...layers, [t.key]: e.target.checked })}
                  className="h-5 w-5 accent-hl-teal"
                />
                {t.label}
              </label>
            ))}
          </fieldset>

          <div className="flex flex-col gap-1 text-meta text-hl-muted">
            <p className="font-medium">Fire detections</p>
            <p className="flex items-center gap-2 text-white">
              <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-[#fb923c]" /> under 6 h
              <span aria-hidden="true" className="ml-2 h-3 w-3 rounded-sm bg-[#ea580c]" /> 6–24 h
              <span aria-hidden="true" className="ml-2 h-3 w-3 rounded-sm bg-[#9a3412]" /> older
            </p>
            <p>Unconfirmed satellite pixel footprints. {fireStatus}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
