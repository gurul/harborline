/**
 * Harborline API service.
 *
 * Hono over @hono/node-server. Boot order matters: ingestion starts (and, in
 * demo mode, the seeded scenario is loaded synchronously) before the listener
 * opens, so the first request never sees an empty store.
 *
 * Middleware order is also load-bearing, cheapest rejection first:
 *   secure headers → CORS → rate limit → body limit → routes.
 * A request that will be refused should never reach body parsing.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { assistantRoutes } from "./routes/assistant.js";
import { eventsRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { resourcesRoutes } from "./routes/resources.js";
import { routesRoutes } from "./routes/routes.js";
import { streamRoutes } from "./routes/stream.js";
import { createRateLimit } from "./rate-limit.js";
import { getSourceHealth, startScheduler, stopScheduler } from "./scheduler.js";
import { isDemoMode, setDraining, store } from "./state.js";

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** General ceiling across the v1 surface, per client, per minute. */
export const GENERAL_RATE_LIMIT = 120;
/** The assistant path is the expensive one — tool fan-out plus a model call. */
export const ASSISTANT_RATE_LIMIT = 6;
/** Ask bodies are a question and a coordinate. 8 KiB is generous. */
export const ASSISTANT_MAX_BODY_BYTES = 8 * 1024;

/**
 * Parse `ALLOWED_ORIGINS` (comma-separated) into an exact-match set.
 * Returns `null` when unset, which selects the environment-dependent default.
 */
export function parseAllowedOrigins(raw: string | undefined): Set<string> | null {
  if (raw === undefined) return null;
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return entries.length > 0 ? new Set(entries) : null;
}

/**
 * Resolve the ACAO value for a request origin.
 *
 * Configured allowlist wins. With no allowlist, development trusts localhost
 * (so `npm run dev:web` works out of the box) and production trusts nothing —
 * an unconfigured production deploy denies cross-origin rather than falling
 * back to a permissive default.
 */
export function resolveOrigin(
  origin: string,
  allowed: Set<string> | null,
  nodeEnv: string | undefined,
): string | null {
  if (allowed) return allowed.has(origin) ? origin : null;
  if (nodeEnv === "production") return null;
  return LOCALHOST_ORIGIN.test(origin) ? origin : null;
}

export function createApp(): Hono {
  const app = new Hono();

  // 1. Security headers. This is a JSON API: it loads nothing and is framed by
  //    nobody, so the CSP denies everything rather than enumerating sources.
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  // 2. CORS. Read once at app construction so the policy cannot drift per
  //    request, and stays inspectable in tests.
  const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  const nodeEnv = process.env.NODE_ENV;
  app.use(
    "*",
    cors({
      origin: (origin) => resolveOrigin(origin, allowedOrigins, nodeEnv),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Accept"],
      // No credentials: this API has no cookies or sessions to leak.
      maxAge: 86_400,
    }),
  );

  // 3. Rate limiting. A general bucket for the whole v1 surface, plus a much
  //    tighter one on the assistant, which costs orders of magnitude more per
  //    call than any read endpoint.
  const generalLimit = createRateLimit({ limit: GENERAL_RATE_LIMIT, name: "v1" });
  const assistantLimit = createRateLimit({ limit: ASSISTANT_RATE_LIMIT, name: "assistant_ask" });

  app.use("/v1/*", generalLimit.middleware);
  app.use("/v1/assistant/ask", (c, next) => {
    // Preflight must not consume the caller's ask budget.
    if (c.req.method !== "POST") return next();
    return assistantLimit.middleware(c, next);
  });

  // 4. Body limit, assistant only — every other endpoint is a GET. The
  //    explicit `onError` keeps the refusal in this API's JSON error shape;
  //    the default throws a plain-text HTTPException.
  app.use(
    "/v1/assistant/*",
    bodyLimit({
      maxSize: ASSISTANT_MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          { error: "payload_too_large", message: "Request body exceeds 8 KiB." },
          413,
        ),
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
    // Middleware signals a deliberate refusal by throwing an HTTPException
    // that already carries its own status and body. A catch-all `onError`
    // overrides Hono's default handling of these, so honour them explicitly —
    // otherwise an intentional 413 is reported to the client as a 500.
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
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

  // Re-entrancy guard: SIGTERM during a SIGINT shutdown, or a second
  // uncaughtException thrown while draining, must not restart the sequence.
  let isShuttingDown = false;
  const shutdown = (signal: string, exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[harborline-api] ${signal} received, shutting down`);
    // Tell long-lived handlers (SSE) to wind down before the socket closes.
    setDraining(true);
    stopScheduler();
    server.close(() => process.exit(exitCode));
    // Do not wait forever on open SSE connections.
    setTimeout(() => process.exit(exitCode), 2000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // A rejected promise nobody awaited is a bug, but it is not necessarily a
  // corrupt process — log it loudly and keep serving.
  process.on("unhandledRejection", (reason) => {
    console.error("[harborline-api] unhandledRejection:", reason);
  });

  // An uncaught exception means some invariant is already broken. Log, then
  // drain: continuing to serve from an unknown state is worse than restarting.
  process.on("uncaughtException", (err) => {
    console.error("[harborline-api] uncaughtException:", err);
    shutdown("uncaughtException", 1);
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  void main();
}

export { store, getSourceHealth, createRateLimit };
