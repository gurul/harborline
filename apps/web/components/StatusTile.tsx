"use client";

import type { ReactNode } from "react";
import { TONE_BAR_CLASS, TONE_TEXT_CLASS, type Tone } from "../lib/format";

/**
 * Every tile owns these states. Empty and error never share words, and no
 * state other than `ok` may show a calm value.
 *
 * - loading: frame and label, a static bar in the value slot.
 * - ok: value, tone, detail, source line.
 * - empty: the source answered and has nothing to report.
 * - stale: the last value, neutral tone, a warning freshness line.
 * - error: the read failed. Shows the last value only as "last value".
 * - not_connected: no source exists for this area.
 */
export type TileState = "loading" | "ok" | "empty" | "stale" | "error" | "not_connected";

export interface StatusTileProps {
  label: string;
  state: TileState;
  value?: string;
  tone?: Tone;
  /** One short line under the value. */
  detail?: ReactNode;
  /** Source and age, e.g. "AirNow · tier B · 20 min ago". Shown in every state that has data. */
  source?: ReactNode;
  /** Replaces the source line in stale and error states. */
  warning?: ReactNode;
  action?: { label: string; onClick: () => void };
  wide?: boolean;
}

const STATE_VALUE: Partial<Record<TileState, string>> = {
  error: "Could not load",
  not_connected: "Not connected",
};

export function StatusTile({
  label,
  state,
  value,
  tone = "neutral",
  detail,
  source,
  warning,
  action,
  wide = false,
}: StatusTileProps) {
  const effectiveTone: Tone = state === "ok" ? tone : "neutral";
  const shownValue = value ?? STATE_VALUE[state] ?? "";
  const valueClass =
    state === "error" ? "text-hl-moderate" : TONE_TEXT_CLASS[effectiveTone];

  return (
    <section
      aria-label={label}
      aria-busy={state === "loading" || undefined}
      className={[
        "flex min-h-28 flex-col gap-1 rounded-2xl bg-hl-panel p-4 lg:min-h-30",
        wide ? "col-span-2" : "",
      ].join(" ")}
    >
      <h3 className="flex items-center gap-2 text-meta font-medium text-hl-muted">
        <span
          aria-hidden="true"
          className={["h-2 w-2 shrink-0 rounded-full", TONE_BAR_CLASS[effectiveTone]].join(" ")}
        />
        {label}
      </h3>

      {state === "loading" ? (
        <>
          <span className="mt-1 block h-7 w-24 rounded-md bg-hl-raised" aria-hidden="true" />
          <p className="text-meta text-hl-muted">Loading…</p>
        </>
      ) : (
        <>
          {state === "error" || state === "not_connected" ? (
            <p className={["text-body font-medium", valueClass].join(" ")}>{shownValue}</p>
          ) : (
            <p className={["text-value font-semibold", valueClass].join(" ")}>{shownValue}</p>
          )}
          {detail ? <p className="text-meta text-white">{detail}</p> : null}
          {state === "stale" || state === "error" ? (
            warning ? (
              <p className="text-meta text-hl-moderate">{warning}</p>
            ) : null
          ) : null}
          {source ? <p className="text-meta text-hl-muted">{source}</p> : null}
        </>
      )}

      {action && state !== "loading" ? (
        <button
          type="button"
          onClick={action.onClick}
          className="-mx-2 mt-auto inline-flex min-h-11 items-center self-start rounded-lg px-2 text-meta font-medium text-white underline underline-offset-4 hover:text-hl-teal"
        >
          {action.label}
        </button>
      ) : null}
    </section>
  );
}
