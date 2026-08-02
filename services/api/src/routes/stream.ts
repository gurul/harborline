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
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { CanonicalEvent } from "@harborline/event-schema";
import { store } from "../state.js";

export const HEARTBEAT_MS = 25_000;
const POLL_MS = 500;

export const streamRoutes = new Hono();

streamRoutes.get("/", (c) =>
  streamSSE(c, async (stream) => {
    const pending: CanonicalEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;

    const unsubscribe = store.onChange((event) => {
      pending.push(event);
      wake?.();
    });

    stream.onAbort(() => {
      done = true;
      unsubscribe();
      wake?.();
    });

    let lastWriteAt = Date.now();
    try {
      while (!done && !stream.aborted && !stream.closed) {
        while (pending.length > 0) {
          const event = pending.shift() as CanonicalEvent;
          await stream.writeSSE({
            event: "feed_update",
            data: JSON.stringify(event),
            id: `${event.event_id}:${event.last_verified_at}`,
          });
          lastWriteAt = Date.now();
        }

        if (done || stream.aborted) break;

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
    }
  }),
);
