"use client";

import { useEffect, useRef } from "react";
import { FALLBACK_LABEL, formatCoordinates } from "../lib/geo";
import { ACCESS_NEEDS, type AccessNeed } from "../lib/preferences";
import { useAppState } from "./AppState";
import { usePreferences } from "./Preferences";
import { Button } from "./ui";

/**
 * Location and access needs. A modal dialog: the native element traps focus
 * and closes on Escape. Every change saves at once.
 */
export function SettingsSheet() {
  const { settings, closeSettings, device, startPicking } = useAppState();
  const { preferences, update } = usePreferences();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const locationRef = useRef<HTMLHeadingElement | null>(null);
  const needsRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (settings.open && !dialog.open) {
      dialog.showModal();
      const target = settings.section === "needs" ? needsRef.current : locationRef.current;
      target?.scrollIntoView({ block: "start" });
      target?.focus();
    } else if (!settings.open && dialog.open) {
      dialog.close();
    }
  }, [settings.open, settings.section]);

  const toggleNeed = (id: AccessNeed, on: boolean) => {
    const next = on ? [...preferences.needs, id] : preferences.needs.filter((n) => n !== id);
    update({ needs: [...new Set(next)] });
  };

  const deviceStatus =
    preferences.locationMode !== "device"
      ? null
      : device.status === "pending"
        ? "Asking the device…"
        : device.status === "ok"
          ? `Using the device location${device.accuracyM ? ` (within about ${Math.round(device.accuracyM)} m)` : ""}.`
          : device.status === "error"
            ? `${device.message} Showing ${FALLBACK_LABEL} until a location is set.`
            : null;

  const radioClass = "mt-0.5 h-5 w-5 shrink-0 accent-hl-teal";
  const optionClass = "flex min-h-11 cursor-pointer items-start gap-3 py-2 text-body text-white";

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="settings-title"
      onClose={closeSettings}
      onCancel={closeSettings}
      onClick={(e) => {
        if (e.target === dialogRef.current) closeSettings();
      }}
      className="fixed m-0 mt-auto max-h-[90dvh] w-full max-w-none overflow-y-auto rounded-t-2xl bg-hl-surface p-0 text-white backdrop:bg-black/70 lg:m-auto lg:max-w-lg lg:rounded-2xl"
    >
      <div className="flex flex-col gap-5 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] lg:p-6">
        <div className="sticky top-0 z-10 -mx-4 -mt-4 flex items-center justify-between gap-3 bg-hl-surface px-4 py-3 lg:-mx-6 lg:-mt-6 lg:px-6">
          <h2 id="settings-title" className="text-value font-semibold">
            Settings
          </h2>
          <Button variant="primary" onClick={closeSettings}>
            Done
          </Button>
        </div>
        <p className="text-meta text-hl-muted">
          Saved on this device only. Your location and access needs are sent with requests so
          Harborline can find what is near you and rank shelters for you. No name, age or other
          personal details are collected.
        </p>

        <fieldset className="flex flex-col gap-1 rounded-2xl bg-hl-panel p-4">
          <legend className="sr-only">Location</legend>
          <h3 ref={locationRef} tabIndex={-1} className="text-body font-medium">
            Location
          </h3>
          <label className={optionClass}>
            <input
              type="radio"
              name="location-mode"
              className={radioClass}
              checked={preferences.locationMode === "device"}
              onChange={() => {
                update({ locationMode: "device" });
                device.retry();
              }}
            />
            <span>Use my device location</span>
          </label>
          {deviceStatus ? (
            <div className="flex flex-wrap items-center gap-2 pl-8">
              <p className={["text-meta", device.status === "error" ? "text-hl-moderate" : "text-hl-muted"].join(" ")}>
                {deviceStatus}
              </p>
              {device.status === "error" ? (
                <Button onClick={device.retry}>Try again</Button>
              ) : null}
            </div>
          ) : null}

          <label className={optionClass}>
            <input
              type="radio"
              name="location-mode"
              className={radioClass}
              checked={preferences.locationMode === "manual"}
              disabled={!preferences.manual}
              onChange={() => update({ locationMode: "manual" })}
            />
            <span>
              A point I picked on the map
              <span className="block text-meta text-hl-muted">
                {preferences.manual
                  ? formatCoordinates(preferences.manual.lon, preferences.manual.lat)
                  : "None picked yet."}
              </span>
            </span>
          </label>
          <div className="pl-8">
            <Button onClick={startPicking}>Pick on the map</Button>
          </div>

          <label className={optionClass}>
            <input
              type="radio"
              name="location-mode"
              className={radioClass}
              checked={preferences.locationMode === "demo"}
              onChange={() => update({ locationMode: "demo" })}
            />
            <span>
              Demo default: {FALLBACK_LABEL}
              <span className="block text-meta text-hl-muted">An approximate point, marked as such.</span>
            </span>
          </label>
        </fieldset>

        <fieldset className="flex flex-col gap-1 rounded-2xl bg-hl-panel p-4">
          <legend className="sr-only">Access needs</legend>
          <h3 ref={needsRef} tabIndex={-1} className="text-body font-medium">
            Access needs
          </h3>
          <p className="text-meta text-hl-muted">All off by default. Each one changes a result.</p>
          {ACCESS_NEEDS.map((need) => (
            <label key={need.id} className={optionClass}>
              <input
                type="checkbox"
                className={radioClass}
                checked={preferences.needs.includes(need.id)}
                onChange={(e) => toggleNeed(need.id, e.target.checked)}
              />
              <span>
                {need.label}
                <span className="block text-meta text-hl-muted">{need.effect}</span>
              </span>
            </label>
          ))}
          <label className={optionClass}>
            <input
              type="checkbox"
              className={radioClass}
              checked={preferences.largeText}
              onChange={(e) => update({ largeText: e.target.checked })}
            />
            <span>
              Larger text
              <span className="block text-meta text-hl-muted">Stays on this device.</span>
            </span>
          </label>
        </fieldset>
      </div>
    </dialog>
  );
}
