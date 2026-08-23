/**
 * Ingestion scheduler.
 *
 * One self-rescheduling timer chain per connector (a `setTimeout` chain rather
 * than `setInterval`, so a slow fetch cannot stack runs or drift the cadence).
 * A failed fetch — whether the connector returns `{ ok: false }` or throws —
 * only has to decide when to try again:
 *
 *   - Backoff is `base × 2^consecutive_failures`, capped at 300s. Because the
 *     circuit opens at the 3rd consecutive failure, the backoff path is only
 *     ever walked for failures 1 and 2: in practice `base × 2` then `base × 4`.
 *   - From the 3rd consecutive failure the circuit is open and the chain
 *     switches to a fixed half-open probe every 300s until one fetch succeeds,
 *     which resets the failure count and the circuit together.
 *
 * The chain is unconditionally rescheduled after every attempt, so no failure
 * mode — including a throwing store listener — can silently end polling.
 *
 * A separate 5-minute sweep expires and prunes stored events, so a long-running
 * process does not accumulate events past their retention window.
 *
 * Health is observable per source via `getSourceHealth()`.
 */
import type {
  Connector,
  ConnectorResult,
  SourceHealth,
  SourceRecord,
} from "@harborline/event-schema";
import type { EventStore } from "@harborline/agent-tools";
import { allConnectors, demoConnector } from "@harborline/connectors";
import { store as defaultStore } from "./state.js";

/** Backoff ceiling and half-open probe interval, in seconds. */
export const BACKOFF_CAP_SECONDS = 300;
export const CIRCUIT_FAILURE_THRESHOLD = 3;
export const HALF_OPEN_RETRY_SECONDS = 300;
/** How often expired events are swept out of the store. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface ConnectorState {
  connector: Connector;
  health: SourceHealth;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

const states = new Map<string, ConnectorState>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function initialHealth(connector: Connector): SourceHealth {
  return {
    id: connector.id,
    label: connector.label,
    healthy: false,
    last_success_at: null,
    last_error: null,
    consecutive_failures: 0,
    circuit_open: false,
    last_success_records: null,
  };
}

/** Snapshot of per-source health. Copies, so callers cannot mutate state. */
export function getSourceHealth(): SourceHealth[] {
  return [...states.values()].map((s) => ({ ...s.health }));
}

/**
 * Write a successful fetch into the store: events carry the source records that
 * mention them (grouped by `event_id`), resources go in as-is. Provenance is
 * never dropped — records without an `event_id` belong to resources or to a
 * contradiction and are simply not attached to an event.
 */
function applyItems(
  target: EventStore,
  result: Extract<ConnectorResult, { ok: true }>,
): { events: number; resources: number } {
  const byEvent = new Map<string, SourceRecord[]>();
  for (const record of result.source_records) {
    if (!record.event_id) continue;
    const bucket = byEvent.get(record.event_id);
    if (bucket) bucket.push(record);
    else byEvent.set(record.event_id, [record]);
  }

  for (const event of result.events) {
    target.upsertEvent(event, byEvent.get(event.event_id) ?? []);
  }
  for (const resource of result.resources) {
    target.upsertResource(resource);
  }

  return { events: result.events.length, resources: result.resources.length };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fold a failed attempt into the connector's health. */
function recordFailure(state: ConnectorState, error: string): boolean {
  // The full error text stays here, in the log. `/v1/health` publishes only a
  // coarse category, so upstream URLs and credentials never leave the process.
  console.warn(`[scheduler] ${state.connector.id} fetch failed: ${error}`);
  state.health.healthy = false;
  state.health.last_error = error;
  state.health.consecutive_failures += 1;
  if (state.health.consecutive_failures >= CIRCUIT_FAILURE_THRESHOLD) {
    state.health.circuit_open = true;
  }
  return false;
}

/** Run one fetch and fold the outcome into the connector's health. */
async function runOnce(state: ConnectorState, target: EventStore): Promise<boolean> {
  const now = new Date();
  try {
    const result: ConnectorResult = await state.connector.fetch(now);
    if (!result.ok) return recordFailure(state, result.error);

    // Inside the try on purpose: `applyItems` fans out to store listeners
    // (the SSE feed), and a listener that throws is a failed ingest — not a
    // reason to kill this connector's timer chain.
    applyItems(target, result);

    state.health.healthy = true;
    state.health.last_success_at = result.retrieved_at;
    state.health.last_error = null;
    state.health.consecutive_failures = 0;
    state.health.circuit_open = false;
    // "Healthy" alone cannot distinguish "fetched fine" from "fetched fine
    // but yielded zero records" — the green-but-empty failure mode that hid
    // both the NWS zone-geometry drop and the FEMA timestamp drop. Publish
    // what the fetch actually contributed so monitoring can catch it.
    state.health.last_success_records = {
      events: result.events.length,
      resources: result.resources.length,
    };
    return true;
  } catch (err) {
    // A connector should never throw. If one does, treat it as a failed fetch.
    return recordFailure(state, errorMessage(err));
  }
}

/** Seconds to wait before the next attempt, given the current health. */
function nextDelaySeconds(state: ConnectorState, elapsedSeconds: number): number {
  const base = Math.max(1, state.connector.expected_refresh_seconds);
  const failures = state.health.consecutive_failures;

  if (state.health.circuit_open) return HALF_OPEN_RETRY_SECONDS;
  if (failures > 0) {
    return Math.min(base * 2 ** failures, BACKOFF_CAP_SECONDS);
  }
  // Drift guard: subtract the time the fetch itself consumed.
  return Math.max(0, base - elapsedSeconds);
}

function schedule(state: ConnectorState, target: EventStore, delaySeconds: number): void {
  if (state.stopped) return;
  const timer = setTimeout(() => {
    void tick(state, target);
  }, delaySeconds * 1000);
  // Never keep the process alive purely for polling.
  timer.unref?.();
  state.timer = timer;
}

async function tick(state: ConnectorState, target: EventStore): Promise<void> {
  if (state.stopped) return;
  const startedAt = Date.now();
  try {
    await runOnce(state, target);
  } finally {
    // Rescheduling in `finally` is what makes the chain unkillable: even if
    // `runOnce` somehow escapes with an exception, the next attempt is armed.
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    schedule(state, target, nextDelaySeconds(state, elapsedSeconds));
  }
}

/**
 * Periodically expire and prune stored events. Optional on the `EventStore`
 * interface, so a store without it simply never sweeps.
 */
function startSweep(target: EventStore): void {
  if (sweepTimer) return;
  const timer = setInterval(() => {
    try {
      const result = target.sweepExpired?.(new Date());
      if (result && (result.expired > 0 || result.deleted > 0)) {
        console.log(
          `[scheduler] store sweep: expired=${result.expired} deleted=${result.deleted}`,
        );
      }
    } catch (err) {
      console.warn(`[scheduler] store sweep failed: ${errorMessage(err)}`);
    }
  }, SWEEP_INTERVAL_MS);
  // Housekeeping must never be the reason the process stays alive.
  timer.unref?.();
  sweepTimer = timer;
}

export interface SchedulerOptions {
  store?: EventStore;
  demoMode: boolean;
  /** Override the live connector set (tests). */
  connectors?: Connector[];
}

export interface SchedulerStartResult {
  demo_loaded: boolean;
  live_connector_ids: string[];
}

/**
 * Start ingestion. In demo mode the seeded scenario is loaded once, up front,
 * so the store is populated before the first request — live connectors keep
 * running alongside it.
 */
export async function startScheduler(opts: SchedulerOptions): Promise<SchedulerStartResult> {
  const target = opts.store ?? defaultStore;
  const live = opts.connectors ?? allConnectors({ demoMode: false });

  // Restart-safe: `stopScheduler` latches `stopped`, which would make every
  // retained state refuse to schedule. Clear it before arming anything.
  for (const state of states.values()) {
    state.stopped = false;
  }

  let demoLoaded = false;
  if (opts.demoMode) {
    // Reuse any retained demo state rather than replacing it — overwriting
    // would orphan the previous state's health history and in-flight timer.
    let demoState = states.get(demoConnector.id);
    if (!demoState) {
      demoState = {
        connector: demoConnector,
        health: initialHealth(demoConnector),
        timer: null,
        stopped: false,
      };
      states.set(demoConnector.id, demoState);
    }
    demoLoaded = await runOnce(demoState, target);
  }

  for (const connector of live) {
    let state = states.get(connector.id);
    if (!state) {
      state = {
        connector,
        health: initialHealth(connector),
        timer: null,
        stopped: false,
      };
      states.set(connector.id, state);
    } else if (state.timer) {
      // Re-arming a state that already holds a timer: drop the old one first
      // so the connector does not end up with two chains.
      clearTimeout(state.timer);
      state.timer = null;
    }
    // First run is immediate; the chain reschedules itself thereafter.
    schedule(state, target, 0);
  }

  startSweep(target);

  return { demo_loaded: demoLoaded, live_connector_ids: live.map((c) => c.id) };
}

/** Stop every timer. Health snapshots are retained. */
export function stopScheduler(): void {
  for (const state of states.values()) {
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Test hook: drop all scheduler state. */
export function resetScheduler(): void {
  stopScheduler();
  states.clear();
}
