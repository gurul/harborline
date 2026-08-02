/**
 * Ingestion scheduler.
 *
 * One self-rescheduling timer chain per connector (a `setTimeout` chain rather
 * than `setInterval`, so a slow fetch cannot stack runs or drift the cadence).
 * Failures never throw — connectors return `{ ok: false }` — so the only thing
 * this module has to decide is when to try again:
 *
 *   - exponential backoff, doubling per consecutive failure, capped at 300s
 *   - circuit breaker after 3 consecutive failures: the circuit opens and only
 *     a half-open probe every 300s is attempted until one succeeds
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

interface ConnectorState {
  connector: Connector;
  health: SourceHealth;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

const states = new Map<string, ConnectorState>();

function initialHealth(connector: Connector): SourceHealth {
  return {
    id: connector.id,
    label: connector.label,
    healthy: false,
    last_success_at: null,
    last_error: null,
    consecutive_failures: 0,
    circuit_open: false,
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

/** Run one fetch and fold the outcome into the connector's health. */
async function runOnce(state: ConnectorState, target: EventStore): Promise<boolean> {
  const now = new Date();
  let result: ConnectorResult;
  try {
    result = await state.connector.fetch(now);
  } catch (err) {
    // A connector should never throw. If one does, treat it as a failed fetch.
    result = { ok: false, retrieved_at: now.toISOString(), error: errorMessage(err) };
  }

  if (result.ok) {
    applyItems(target, result);
    state.health.healthy = true;
    state.health.last_success_at = result.retrieved_at;
    state.health.last_error = null;
    state.health.consecutive_failures = 0;
    state.health.circuit_open = false;
    return true;
  }

  state.health.healthy = false;
  state.health.last_error = result.error;
  state.health.consecutive_failures += 1;
  if (state.health.consecutive_failures >= CIRCUIT_FAILURE_THRESHOLD) {
    state.health.circuit_open = true;
  }
  return false;
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
  await runOnce(state, target);
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  schedule(state, target, nextDelaySeconds(state, elapsedSeconds));
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

  let demoLoaded = false;
  if (opts.demoMode) {
    const demoState: ConnectorState = {
      connector: demoConnector,
      health: initialHealth(demoConnector),
      timer: null,
      stopped: false,
    };
    states.set(demoConnector.id, demoState);
    demoLoaded = await runOnce(demoState, target);
  }

  for (const connector of live) {
    if (states.has(connector.id)) continue;
    const state: ConnectorState = {
      connector,
      health: initialHealth(connector),
      timer: null,
      stopped: false,
    };
    states.set(connector.id, state);
    // First run is immediate; the chain reschedules itself thereafter.
    schedule(state, target, 0);
  }

  return { demo_loaded: demoLoaded, live_connector_ids: live.map((c) => c.id) };
}

/** Stop every timer. Health snapshots are retained. */
export function stopScheduler(): void {
  for (const state of states.values()) {
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }
}

/** Test hook: drop all scheduler state. */
export function resetScheduler(): void {
  stopScheduler();
  states.clear();
}
