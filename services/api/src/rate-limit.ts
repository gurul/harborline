/**
 * In-memory per-IP token bucket. No dependencies, no shared store.
 *
 * Scope note: this is a single-process limiter. It protects one instance from
 * one noisy client — it is NOT a distributed quota, and behind more than one
 * replica the effective limit multiplies by the replica count. That is an
 * acceptable trade for a service whose expensive path (the assistant) is
 * already capped by its own concurrency semaphore.
 *
 * A token bucket rather than a fixed window: bursts up to `limit` are allowed,
 * then the client is metered at `limit` per window with no boundary spike at
 * the window edge.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

/** How often idle buckets are swept out of the map. */
export const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
/** A bucket untouched for this long is dropped — it has fully refilled anyway. */
export const IDLE_TTL_MS = 10 * 60 * 1000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitOptions {
  /** Requests permitted per window (also the burst capacity). */
  limit: number;
  /** Window length in milliseconds. Defaults to one minute. */
  windowMs?: number;
  /** Label used in logs. */
  name: string;
}

export interface RateLimiter {
  middleware: MiddlewareHandler;
  /** Test hook: drop all buckets. */
  reset(): void;
  /** Test hook: stop the prune timer. */
  stop(): void;
}

/**
 * Identify the caller. `x-forwarded-for` first (the deployment terminates TLS
 * at a proxy), falling back to the socket address. The first XFF entry is the
 * only one a proxy is required to set from the real peer; it is spoofable by a
 * direct client, which is why this is rate limiting and not authorization.
 */
export function clientKey(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  try {
    const address = getConnInfo(c).remote.address;
    if (address) return address;
  } catch {
    // Not running on @hono/node-server (unit tests use `app.request`).
  }
  return "unknown";
}

/**
 * Build a rate-limiting middleware. Exported as a factory so tests can create
 * an isolated limiter with its own bucket map instead of sharing app state.
 */
export function createRateLimit(options: RateLimitOptions): RateLimiter {
  const windowMs = options.windowMs ?? 60_000;
  const capacity = options.limit;
  const refillPerMs = capacity / windowMs;
  const buckets = new Map<string, Bucket>();

  const pruneTimer = setInterval(() => {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const [key, bucket] of buckets) {
      if (bucket.updatedAt < cutoff) buckets.delete(key);
    }
  }, PRUNE_INTERVAL_MS);
  // Never hold the process open just to prune a cache.
  pruneTimer.unref?.();

  const middleware: MiddlewareHandler = async (c, next) => {
    const key = clientKey(c);
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };

    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      const retryAfterS = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000));
      c.header("Retry-After", String(retryAfterS));
      return c.json(
        { error: "rate_limited", message: "Too many requests. Retry shortly." },
        429,
      );
    }

    bucket.tokens -= 1;
    buckets.set(key, bucket);
    await next();
  };

  return {
    middleware,
    reset: () => buckets.clear(),
    stop: () => clearInterval(pruneTimer),
  };
}
