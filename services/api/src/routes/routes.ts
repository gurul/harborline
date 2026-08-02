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
import { store } from "../state.js";

const RoutesQuerySchema = z.object({
  from_lat: z.coerce.number().min(-90).max(90),
  from_lon: z.coerce.number().min(-180).max(180),
  to_resource_id: z.string().min(1),
});

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
        message: "`from_lat`, `from_lon` and `to_resource_id` are required.",
        issues: parsed.error.issues,
      },
      400,
    );
  }

  if (!store.getResource(parsed.data.to_resource_id)) {
    return c.json({ error: "not_found", message: "No resource with that id." }, 404);
  }

  const result = tools.calculate_routes({ store, now: new Date() }, parsed.data);

  if (!result.recommendation) {
    // Candidates are still returned: the elimination reasons are the answer.
    return c.json(
      {
        error: "no_viable_route",
        message:
          "No route to this destination avoids the reported closures. Contact local emergency services.",
        candidates: result.candidates,
        destination: result.destination,
        routing: result.routing,
        generated_at: result.generated_at,
      },
      422,
    );
  }

  return c.json({
    candidates: result.candidates,
    recommendation: result.recommendation,
    destination: result.destination,
    routing: result.routing,
    generated_at: result.generated_at,
  });
});
