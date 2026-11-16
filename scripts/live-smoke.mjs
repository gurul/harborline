#!/usr/bin/env node
/**
 * Live smoke check for the environment and fire connectors.
 *
 * Calls each connector's fetch once against the live service and prints one
 * line per connector: ok or FAIL, record count, and the age of the newest
 * record. Prints LIVE_SMOKE_OK and exits 0 only when every connector returns
 * ok:true. Zero records with ok:true passes: an empty region is normal.
 *
 * This makes real network calls. It is a manual check, not part of CI.
 * Run after `npm run build:libs`:  npm run -s smoke:live
 */
import { ENVIRONMENT_CONNECTOR_IDS, allConnectors } from "../connectors/dist/index.js";

const now = new Date();
const wanted = new Set(ENVIRONMENT_CONNECTOR_IDS);
const connectors = allConnectors({ demoMode: false }).filter((c) => wanted.has(c.id));

function newestAge(result) {
  const times = [
    ...(result.events ?? []).map((e) => e.last_verified_at),
    ...(result.observations ?? []).map((o) => o.last_verified_at),
  ]
    .map((t) => new Date(t).getTime())
    .filter(Number.isFinite);
  if (times.length === 0) return "n/a";
  const minutes = Math.round((now.getTime() - Math.max(...times)) / 60_000);
  return minutes < 120 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

let allOk = connectors.length === ENVIRONMENT_CONNECTOR_IDS.length;
if (!allOk) console.log(`registered ${connectors.length} of ${ENVIRONMENT_CONNECTOR_IDS.length} environment connectors`);

const results = await Promise.all(
  connectors.map(async (c) => {
    const started = Date.now();
    try {
      return { c, result: await c.fetch(now), ms: Date.now() - started };
    } catch (err) {
      return { c, result: { ok: false, error: String(err) }, ms: Date.now() - started };
    }
  }),
);

for (const { c, result, ms } of results) {
  if (result.ok) {
    const events = result.events?.length ?? 0;
    const observations = result.observations?.length ?? 0;
    console.log(
      `${c.id.padEnd(14)} ok    records=${String(events + observations).padStart(4)} ` +
        `(events ${events}, observations ${observations})  newest=${newestAge(result)}  ${ms} ms`,
    );
  } else {
    allOk = false;
    console.log(`${c.id.padEnd(14)} FAIL  ${result.error}  ${ms} ms`);
  }
}

if (allOk) {
  console.log("LIVE_SMOKE_OK");
} else {
  console.log("LIVE_SMOKE_FAILED");
  process.exitCode = 1;
}
