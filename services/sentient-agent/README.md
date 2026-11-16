# Harborline × Sentient Agent Framework

Serves Harborline as a **Sentient Chat agent** over the official
[Sentient Agent Framework](https://github.com/sentient-agi/Sentient-Agent-Framework)
SSE protocol (`POST /assist`). The adapter is pure presentation: it forwards the
question to Harborline's evidence-gated assistant (`POST /v1/assistant/ask`) and
re-emits the already-validated result as Sentient Chat events — `EVIDENCE`,
`LOCATION`, a streamed `ANSWER`, `ACTION`, and `CAVEATS`. No decision logic lives here.

Every question is answered for one configured location (`HARBORLINE_LAT` /
`HARBORLINE_LON`), not the asker's own position. The `LOCATION` block and
`CAVEATS.location_note` say which point the answer assumed. A `429` from the API
(rate limit; all chat users share the agent's address) is reported as "busy, ask
again", and a `400` as "question not accepted, keep it under 500 characters".

## Run

Requires Python ≥ 3.10 and the Harborline API on `:8787`.

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
PORT=8100 .venv/bin/python agent.py
```

## Try it

```bash
curl -N -X POST http://localhost:8100/assist \
  -H 'Content-Type: application/json' \
  -d '{"query":{"id":"01JD2XX0000000000000000000","prompt":"Where is the nearest open shelter?"},
       "session":{"processor_id":"harborline-demo",
                  "activity_id":"01JD2XX0000000000000000001",
                  "request_id":"01JD2XX0000000000000000002",
                  "interactions":[]}}'
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HARBORLINE_API_URL` | `http://localhost:8787` | Harborline REST base URL |
| `HARBORLINE_LAT` / `HARBORLINE_LON` | region centre (Chico) | Location used for every query; each answer states it |
| `PORT` | `8100` | SSE server port |
