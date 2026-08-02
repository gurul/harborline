/**
 * Process-wide singletons.
 *
 * The store is the only place facts live. Routes read from it, the scheduler
 * writes to it, and nothing else in this service originates a value.
 */
import { MemoryStore } from "@harborline/agent-tools";

export const store = new MemoryStore();

const BOOT_AT = Date.now();

export function uptimeSeconds(): number {
  return Math.round((Date.now() - BOOT_AT) / 1000);
}

/** DEMO_MODE defaults ON: enabled when unset or "1". */
export function isDemoMode(): boolean {
  const raw = process.env.DEMO_MODE;
  return raw === undefined || raw === "" || raw === "1";
}
