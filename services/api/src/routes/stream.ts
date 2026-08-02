/**
 * Server-sent event feed.
 *
 * One `feed_update` per store upsert, carrying the full CanonicalEvent so the
 * client never has to re-fetch to know what changed. A comment heartbeat every
 * 25s keeps intermediaries from reaping an idle connection.
 *
 * Writes are serialised through a single loop — the heartbeat is emitted from
 * the same loop as the events rather than a parallel timer, so two writers can
 * never interleave on the stream.
 *
 * Two bounds keep a slow or hostile client from costing the process memory:
 * a cap on concurrent connections, and a cap on the per-connection backlog. A
 * client that falls too far behind is told to resynchronise rather than being
 * buffered indefinitely — the store is the source of truth, so a refetch always
 * recovers correctly.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { CanonicalEvent } from "@harborline/event-schema";
import { isDraining, store } from "../state.js";

export const HEARTBEAT_MS = 25_000;
const POLL_MS = 500;

/** Concurrent SSE connections this process will hold open. */
export const MAX_CONCURRENT_STREAMS = 200;
/** Events buffered for one slow client before it is asked to resynchronise. */
export const MAX_PENDING_EVENTS = 500;

let openStreams = 0;

/** Current open-connection count. Exported for tests and diagnostics. */
export function openStreamCount(): number {
  return openStreams;
}

/**
 * CR and LF terminate an SSE field. An id carrying either would let event data
 * forge additional frames on the wire, so strip them.
 */
function sanitizeSseId(id: string): string {
  return id.replace(/[\r\n]/g, "");
}

export const streamRoutes = new Hono();

streamRoutes.get("/", (c) => {
  if (openStreams >= MAX_CONCURRENT_STREAMS) {
    return c.json(
      { error: "too_many_streams", message: "Stream capacity reached. Retry shortly." },
      503,
    );
  }
  openStreams += 1;

  return streamSSE(c, async (stream) => {
    const pending: CanonicalEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let overflowed = false;

    const unsubscribe = store.onChange((event) => {
      if (pending.length >= MAX_PENDING_EVENTS) {
        // Drop the backlog wholesale rather than growing it. One resync frame
        // is cheaper to send and cheaper for the client to act on than 500
        // stale updates it is already behind on.
        pending.length = 0;
        overflowed = true;
      } else {
        pending.push(event);
      }
      wake?.();
    });

    stream.onAbort(() => {
      done = true;
      unsubscribe();
      wake?.();
    });

    let lastWriteAt = Date.now();
    try {
      while (!done && !isDraining() && !stream.aborted && !stream.closed) {
        if (overflowed) {
          overflowed = false;
          await stream.writeSSE({
            event: "resync",
            data: JSON.stringify({ reason: "buffer_overflow" }),
          });
          lastWriteAt = Date.now();
        }

        while (pending.length > 0) {
          const event = pending.shift() as CanonicalEvent;
          await stream.writeSSE({
            event: "feed_update",
            data: JSON.stringify(event),
            id: sanitizeSseId(`${event.event_id}:${event.last_verified_at}`),
          });
          lastWriteAt = Date.now();
        }

        if (done || isDraining() || stream.aborted) break;

        if (Date.now() - lastWriteAt >= HEARTBEAT_MS) {
          await stream.writeln(": heartbeat");
          lastWriteAt = Date.now();
        }

        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, POLL_MS);
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        });
      }
    } finally {
      unsubscribe();
      openStreams -= 1;
    }
  });
});
