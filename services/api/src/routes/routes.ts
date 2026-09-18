/**
 * Routing endpoint.
 *
 * All of the risk logic lives in `@harborline/agent-tools`; this handler only
 * validates input and shapes the response. Every payload carries
 * `routing: "demonstration"` — the graph is a bounded demo lattice, not a
 * production routing engine.
 */
import { Hono } from "hono";
import { z } from "zod";
import { tools } from "@harborline/agent-tools";
import type { RouteCandidate } from "@harborline/event-schema";
import { store } from "../state.js";
import { invalidQueryMessage, issueSummary, latParam, lonParam } from "../validation.js";

/**
 * Stand-in for an unroutable candidate's risk. The router uses
 * `Number.POSITIVE_INFINITY`, which `JSON.stringify` emits as `null` — that
 * breaks the `risk_score: number` contract and reads to a client as "no score
 * computed" rather than "maximally bad". A finite sentinel keeps the typed
 * shape honest and still sorts last everywhere.
 */
export const UNROUTABLE_RISK_SCORE = Number.MAX_SAFE_INTEGER;

const RoutesQuerySchema = z.object({
  from_lat: latParam(),
  from_lon: lonParam(),
  to_resource_id: z.string().min(1),
});

/** Replace non-finite risk scores at the API boundary. */
export function serializableCandidates(candidates: RouteCandidate[]): RouteCandidate[] {
  return candidates.map((candidate) =>
    Number.isFinite(candidate.risk_score)
      ? candidate
      : { ...candidate, risk_score: UNROUTABLE_RISK_SCORE },
  );
}

export const routesRoutes = new Hono();

routesRoutes.get("/", (c) => {
  const parsed = RoutesQuerySchema.safeParse({
    from_lat: c.req.query("from_lat"),
    from_lon: c.req.query("from_lon"),
    to_resource_id: c.req.query("to_resource_id"),
  });
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_query",
        message: invalidQueryMessage(parsed.error),
        issues: issueSummary(parsed.error),
      },
      400,
    );
  }

  if (!store.getResource(parsed.data.to_resource_id)) {
    return c.json({ error: "not_found", message: "No resource with that id." }, 404);
  }

  const result = tools.calculate_routes({ store, now: new Date() }, parsed.data);

  if (result.destination_rejected_reason) {
    return c.json({
      error: "destination_unavailable",
      message: "This destination does not meet the current resource recommendation policy.",
      rejected_reason: result.destination_rejected_reason,
      candidates: [],
      destination: result.destination,
      routing: result.routing,
      generated_at: result.generated_at,
    }, 422);
  }

  if (!result.recommendation) {
    // Candidates are still returned: the elimination reasons are the answer.
    return c.json(
      {
        error: "no_viable_route",
        message:
          "No route to this destination is verified by the demonstration graph. Contact local emergency services for directions.",
        candidates: serializableCandidates(result.candidates),
        destination: result.destination,
        routing: result.routing,
        generated_at: result.generated_at,
      },
      422,
    );
  }

  return c.json({
    candidates: serializableCandidates(result.candidates),
    recommendation: result.recommendation,
    destination: result.destination,
    routing: result.routing,
    generated_at: result.generated_at,
  });
});
