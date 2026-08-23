"""Serve Harborline as a Sentient Chat agent (Sentient Agent Framework).

This is the GRID integration described in docs/SENTIENT.md: a thin Python
adapter that exposes Harborline's already-validated assistant over the Sentient
Agent Framework's SSE `POST /assist` protocol. No decision logic lives here —
the adapter forwards the question to Harborline's API (plan → gather → compose
→ validate, deterministic fallback included) and re-emits the validated result
as Sentient Chat events:

  EVIDENCE     emit_json  — the sources backing the answer (provider, tier, age)
  ANSWER       text stream — answer_markdown, streamed in chunks
  ACTION       emit_text_block — the one-line recommended action, when present
  CAVEATS      emit_json  — freshness and uncertainty notes

Run:  python agent.py           (serves on :8100 by default)
Env:  HARBORLINE_API_URL (default http://localhost:8787)
      HARBORLINE_LAT / HARBORLINE_LON (default: demo region centre, Chico CA)
      PORT (default 8100)
"""

import os

import httpx
from sentient_agent_framework import (
    AbstractAgent,
    DefaultServer,
    Query,
    ResponseHandler,
    Session,
)

HARBORLINE_API_URL = os.environ.get("HARBORLINE_API_URL", "http://localhost:8787")
# Location comes from the chat surface in a real deployment; the fallback is
# the same region-centre default the web client uses.
DEFAULT_LAT = float(os.environ.get("HARBORLINE_LAT", "39.7285"))
DEFAULT_LON = float(os.environ.get("HARBORLINE_LON", "-121.8375"))
ANSWER_CHUNK_CHARS = 160


class HarborlineAgent(AbstractAgent):
    """Sentient Chat surface over Harborline's evidence-gated assistant."""

    def __init__(self, name: str = "Harborline"):
        super().__init__(name)

    async def assist(
        self,
        session: Session,
        query: Query,
        response_handler: ResponseHandler,
    ):
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                api_response = await client.post(
                    f"{HARBORLINE_API_URL}/v1/assistant/ask",
                    json={
                        "question": query.prompt,
                        "lat": DEFAULT_LAT,
                        "lon": DEFAULT_LON,
                    },
                )
                api_response.raise_for_status()
                answer = api_response.json()
        except httpx.HTTPError as err:
            await response_handler.emit_error(
                f"Harborline service unreachable: {err}. "
                "No answer is better than an unverified one.",
                500,
            )
            await response_handler.complete()
            return

        # Provenance first: every fact in the answer is backed by these records.
        await response_handler.emit_json(
            "EVIDENCE",
            {
                "sources": answer.get("sources", []),
                "evidence_event_ids": answer.get("evidence_event_ids", []),
                "composed_by": answer.get("composed_by"),
            },
        )

        # The validated answer, streamed the way Sentient Chat expects.
        stream = response_handler.create_text_stream("ANSWER")
        markdown = answer.get("answer_markdown", "")
        for start in range(0, len(markdown), ANSWER_CHUNK_CHARS):
            await stream.emit_chunk(markdown[start : start + ANSWER_CHUNK_CHARS])
        await stream.complete()

        if answer.get("recommended_action"):
            await response_handler.emit_text_block(
                "ACTION", answer["recommended_action"]
            )

        caveats = {
            key: answer[key]
            for key in ("freshness_note", "uncertainty_note")
            if answer.get(key)
        }
        if caveats:
            await response_handler.emit_json("CAVEATS", caveats)

        await response_handler.complete()


if __name__ == "__main__":
    server = DefaultServer(HarborlineAgent())
    server.run(port=int(os.environ.get("PORT", "8100")))
