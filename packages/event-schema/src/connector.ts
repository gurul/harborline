import type { CanonicalEvent, SourceRecord, SourceTier } from "./events.js";
import type { Resource } from "./resources.js";

export interface ConnectorItems {
  events: CanonicalEvent[];
  resources: Resource[];
  source_records: SourceRecord[];
}

export type ConnectorResult =
  | ({ ok: true; retrieved_at: string } & ConnectorItems)
  | { ok: false; retrieved_at: string; error: string };

/**
 * A connector fetches one upstream source and returns canonical items.
 * Connectors NEVER throw to the scheduler — failures come back as { ok: false }.
 */
export interface Connector {
  id: string;
  label: string;
  source_tier: SourceTier;
  expected_refresh_seconds: number;
  fetch(now: Date): Promise<ConnectorResult>;
}

export interface SourceHealth {
  id: string;
  label: string;
  healthy: boolean;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  circuit_open: boolean;
}
