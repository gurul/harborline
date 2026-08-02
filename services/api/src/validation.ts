/**
 * Shared query-parameter validation helpers.
 *
 * Two problems this module exists to solve:
 *
 *   1. `?lat=` arrives as the empty string, and `z.coerce.number()` turns `""`
 *      into `0` — a silently valid coordinate off the coast of Africa. Every
 *      numeric query param is therefore wrapped in `blankable`, which maps
 *      empty and whitespace-only strings to `undefined` before coercion runs,
 *      so a blank param is "missing" rather than "zero".
 *
 *   2. Raw `ZodError.issues` leak schema internals (expected/received types,
 *      nested unions) into public error bodies. `issueSummary` reduces them to
 *      the path and the code, which is all a client can act on.
 */
import { z } from "zod";

/** Map `""` / whitespace-only strings to `undefined`; pass everything else through. */
function blankToUndefined(value: unknown): unknown {
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  return value;
}

/**
 * Wrap a schema so blank query strings are treated as absent. Applies to both
 * optional params (blank → `undefined` → accepted) and required ones
 * (blank → `undefined` → "required" issue, never `0`).
 */
export function blankable<T extends z.ZodType>(schema: T) {
  return z.preprocess(blankToUndefined, schema);
}

/** Latitude query param, blank-safe. */
export const latParam = () => blankable(z.coerce.number().min(-90).max(90));
/** Longitude query param, blank-safe. */
export const lonParam = () => blankable(z.coerce.number().min(-180).max(180));
/** Radius query param, blank-safe and optional. */
export const radiusParam = () => blankable(z.coerce.number().positive().max(200_000).optional());
/** Result-count cap, blank-safe. */
export const limitParam = (fallback: number, max: number) =>
  blankable(z.coerce.number().int().positive().max(max).default(fallback));

/** Public-safe issue shape: enough to fix the request, nothing about the schema. */
export interface QueryIssue {
  path: string;
  code: string;
}

/** Reduce a `ZodError` to `{ path, code }` pairs for the response body. */
export function issueSummary(error: z.ZodError): QueryIssue[] {
  return error.issues.map((i) => ({ path: i.path.map((p) => String(p)).join("."), code: i.code }));
}

function fieldList(fields: string[]): string {
  const quoted = fields.map((f) => `\`${f}\``);
  if (quoted.length === 1) return quoted[0] as string;
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * Build a message naming the fields that actually failed, split by whether they
 * were missing or merely invalid. A request with a bad `radius_m` must not be
 * told that `lat` and `lon` are required.
 */
export function invalidQueryMessage(error: z.ZodError, fallback = "Invalid query parameters."): string {
  const missing: string[] = [];
  const invalid: string[] = [];
  const custom: string[] = [];

  for (const issue of error.issues) {
    const field = issue.path.length > 0 ? String(issue.path[0]) : "";
    if (issue.code === "custom") {
      custom.push(issue.message);
      continue;
    }
    if (field === "") continue;
    // A blank or absent param reaches the coercion as `undefined`.
    const bucket = issue.code === "invalid_type" ? missing : invalid;
    if (!bucket.includes(field)) bucket.push(field);
  }

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`${fieldList(missing)} ${missing.length === 1 ? "is" : "are"} required`);
  }
  if (invalid.length > 0) {
    parts.push(`${fieldList(invalid)} ${invalid.length === 1 ? "is" : "are"} invalid`);
  }

  const derived = parts.length > 0 ? `${parts.join("; ")}.` : "";
  const all = [derived, ...custom].filter((s) => s.length > 0);
  return all.length > 0 ? all.join(" ") : fallback;
}
