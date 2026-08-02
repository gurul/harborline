# Harborline — Infrastructure (optional)

> [!IMPORTANT]
> **Nothing in this directory is required to run Harborline or the demo.**
> The MVP runs in a single Node process with an in-memory store. No database, no
> Docker, no API key. If you are here to run the app, go back to the
> [root README](../README.md) — the quickstart is `npm install`, `npm run build`,
> `npm run dev:api`, `npm run dev:web`.

## What this is

`docker-compose.yml` provisions the two dependencies the roadmap's upgrade path calls for,
so that path is a `docker compose up` rather than a research task.

| Service | Image | Host port | Exists for |
|---|---|---|---|
| `postgis` | `postgis/postgis:16-3.4` | `5432` | The future `PostgisStore` implementation of the `EventStore` interface — durable, indexed geospatial storage |
| `redis` | `redis:7-alpine` | `6379` | Pub/sub fan-out for the SSE change feed across multiple API instances, plus connector response caching |

PostGIS is initialized with database `harborline`, user `harborline`, password
`harborline`. Both services declare healthchecks (`pg_isready` and `redis-cli ping`) so
`docker compose ps` reports readiness rather than mere liveness. Data persists in the named
volumes `postgis-data` and `redis-data`.

## Why it is optional

From [docs/PLAN_EVALUATION.md](../docs/PLAN_EVALUATION.md): the original plan carried
Temporal/Celery, Kafka, Redis, Kubernetes, Terraform, OpenTelemetry, Grafana, and Sentry.
For a pilot serving roughly a hundred users that is operational drag, not resilience. The
correction was a storage **interface** with an in-memory implementation now and a PostGIS
adapter behind the same interface later.

So the MVP ships:

- `MemoryStore` — the default. Linear haversine radius scans, in-process `subscribe()`
  driving SSE, state rebuilt from connectors on boot.
- `EventStore` — the interface, deliberately shaped like a PostGIS table set: geometry in
  and out as GeoJSON, centre-plus-radius queries, source records addressed by entity id,
  single-entity upserts. Every one of those maps to a PostGIS operation with no
  reinterpretation.

Swapping implementations is a constructor change in `services/api/src/index.ts` plus a
migration file. Nothing in the tools, the router, the route handlers, or the web app
changes.

## When to actually start these containers

Only when you are working on the upgrade path itself. The re-entry triggers, from
[docs/ROADMAP.md](../docs/ROADMAP.md):

- **PostGIS** — event volume outgrows process memory (linear scans showing up in request
  latency), state needs to survive restarts, **or** more than one API instance is required.
  Two instances against `MemoryStore` give you two divergent views of the world.
- **Redis** — the same multi-instance condition. `MemoryStore`'s in-process change feed
  cannot cross a process boundary, so a second instance would only stream its own updates.

Wanting a "real database" is not a trigger. Single-instance in-memory is the correct choice
while it holds.

## Usage

```bash
# from the repo root
docker compose -f infrastructure/docker-compose.yml up -d

# check health — wait for both to report (healthy)
docker compose -f infrastructure/docker-compose.yml ps

# connect
psql postgresql://harborline:harborline@localhost:5432/harborline
redis-cli -h localhost -p 6379 ping

# stop, keeping data
docker compose -f infrastructure/docker-compose.yml down

# stop and wipe the volumes
docker compose -f infrastructure/docker-compose.yml down -v
```

If port `5432` or `6379` is already taken on your machine, change the **host** side of the
port mapping in `docker-compose.yml` (`"5433:5432"`), not the container side.

## Not for production

> [!CAUTION]
> This compose file is a **local development convenience**. It ships a hardcoded password,
> binds both services to the host, disables Redis persistence beyond a coarse RDB snapshot,
> and has no TLS, no backups, no resource limits, and no network isolation. Do not deploy
> it. Container images and deployment manifests are a roadmap item gated on there being a
> hosting target at all.
