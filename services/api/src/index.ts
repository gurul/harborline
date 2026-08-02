/**
 * Harborline API service.
 *
 * Hono over @hono/node-server. Boot order matters: ingestion starts (and, in
 * demo mode, the seeded scenario is loaded synchronously) before the listener
 * opens, so the first request never sees an empty store.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { assistantRoutes } from "./routes/assistant.js";
import { eventsRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { resourcesRoutes } from "./routes/resources.js";
import { routesRoutes } from "./routes/routes.js";
import { streamRoutes } from "./routes/stream.js";
import { getSourceHealth, startScheduler, stopScheduler } from "./scheduler.js";
import { isDemoMode, store } from "./state.js";

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function createApp(): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: (origin) => (LOCALHOST_ORIGIN.test(origin) ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Accept"],
      maxAge: 86_400,
    }),
  );

  app.get("/", (c) =>
    c.json({
      service: "harborline-api",
      routing: "demonstration",
      endpoints: [
        "GET /v1/health",
        "GET /v1/events",
        "GET /v1/events/:id",
        "GET /v1/resources",
        "GET /v1/resources/:id",
        "GET /v1/routes",
        "POST /v1/assistant/ask",
        "GET /v1/stream",
      ],
    }),
  );

  app.route("/v1/health", healthRoutes);
  app.route("/v1/events", eventsRoutes);
  app.route("/v1/resources", resourcesRoutes);
  app.route("/v1/routes", routesRoutes);
  app.route("/v1/assistant", assistantRoutes);
  app.route("/v1/stream", streamRoutes);

  app.notFound((c) => c.json({ error: "not_found", message: "Unknown endpoint." }, 404));
  app.onError((err, c) => {
    console.error(`[api] unhandled error on ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: "internal_error", message: "Request failed." }, 500);
  });

  return app;
}

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const demoMode = isDemoMode();

  const started = await startScheduler({ store, demoMode });
  const app = createApp();

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(
      `[harborline-api] listening on http://localhost:${info.port} · demo_mode=${
        demoMode ? "on" : "off"
      } · demo_loaded=${started.demo_loaded} · live_sources=[${started.live_connector_ids.join(
        ",",
      )}] · events=${store.allEvents().length} resources=${store.allResources().length} · sources_tracked=${
        getSourceHealth().length
      }`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`[harborline-api] ${signal} received, shutting down`);
    stopScheduler();
    server.close(() => process.exit(0));
    // Do not wait forever on open SSE connections.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  void main();
}

export { store, getSourceHealth };
