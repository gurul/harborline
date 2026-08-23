import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Dev-only: let the dev server be reached as 127.0.0.1 as well as localhost
  // (a fresh origin with no geolocation grant, useful for demoing the
  // region-centre fallback). Ignored by production builds.
  allowedDevOrigins: ["127.0.0.1"],
  // The canonical schema ships as ESM TypeScript output inside the workspace.
  transpilePackages: ["@harborline/event-schema"],
  // npm workspaces: keep file tracing rooted at the monorepo root.
  outputFileTracingRoot: path.join(here, "../.."),
  experimental: {
    // The repo pins TypeScript 7, whose compiler API Next cannot drive
    // in-process; shell out to `tsc` instead.
    useTypeScriptCli: true,
  },
};

export default nextConfig;
