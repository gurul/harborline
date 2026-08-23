"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  isStale,
  resourceMaxAge,
  type AssistantResponse,
  type NearbyResource,
} from "@harborline/event-schema";
import { askAssistant, fetchResources, fetchRoutes } from "../lib/api";
import { CONFIDENCE_CLASS, formatAge, useNow } from "../lib/format";
import { useAppState } from "./AppState";
import { Markdown } from "./Markdown";

const SUGGESTED_PROMPTS = [
  "Where is the nearest open shelter?",
  "Which roads should I avoid?",
  "What changed in the last hour?",
];

/** Questions that should also produce a route on the map. */
const SHELTER_INTENT =
  /\bshelter|evacuat|somewhere (safe|to stay)|where (can|should) (i|we) go\b/i;

type ChatMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; response: AssistantResponse }
  | { id: string; role: "error"; text: string };

let messageCounter = 0;
function nextId(prefix: string): string {
  messageCounter += 1;
  return `${prefix}-${messageCounter}`;
}

function tierBadgeClass(tier: string): string {
  switch (tier) {
    case "A":
      return CONFIDENCE_CLASS.official;
    case "B":
      return CONFIDENCE_CLASS.verified;
    case "C":
    case "D":
      return CONFIDENCE_CLASS.developing;
    default:
      return CONFIDENCE_CLASS.unverified;
  }
}

export function AssistantPanel() {
  const { user, setRoute, setSelectedResource } = useAppState();
  const now = useNow(30_000);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [routeNote, setRouteNote] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  /**
   * The shelter flow: the answer describes records, the route is computed from
   * the same records — never inferred from the prose.
   */
  async function resolveRoute(): Promise<void> {
    setRouteNote(null);
    const { resources } = await fetchResources({ lat: user.lat, lon: user.lon });
    const openShelters = resources
      .filter((r: NearbyResource) => r.resource_type === "shelter")
      .filter((r) => r.operational_status === "open")
      .filter(
        (r) =>
          !isStale(r.last_verified_at, resourceMaxAge(r.resource_type), now),
      )
      .sort((a, b) => a.distance_m - b.distance_m);

    const destination = openShelters[0];
    if (!destination) {
      setRoute(null);
      setSelectedResource(null);
      setRouteNote("No open shelter with a current verified status — no route drawn.");
      return;
    }

    const routes = await fetchRoutes({
      from_lat: user.lat,
      from_lon: user.lon,
      to_resource_id: destination.resource_id,
    });
    setSelectedResource(destination);
    setRoute(routes);
    if (!routes.recommendation) {
      setRouteNote(
        "Every candidate route was eliminated by an active closure — no recommendation.",
      );
    }
  }

  async function submit(question: string): Promise<void> {
    const trimmed = question.trim();
    if (!trimmed || pending) return;

    setMessages((previous) => [
      ...previous,
      { id: nextId("u"), role: "user", text: trimmed },
    ]);
    setDraft("");
    setPending(true);

    try {
      const response = await askAssistant({
        question: trimmed,
        lat: user.lat,
        lon: user.lon,
      });
      setMessages((previous) => [
        ...previous,
        { id: nextId("a"), role: "assistant", response },
      ]);

      if (SHELTER_INTENT.test(trimmed)) {
        try {
          await resolveRoute();
        } catch (err) {
          setRouteNote(`Routing unavailable (${(err as Error).message}).`);
        }
      }
    } catch (err) {
      setMessages((previous) => [
        ...previous,
        {
          id: nextId("e"),
          role: "error",
          text: `Could not reach the Harborline service (${(err as Error).message}). No answer is better than an unverified one.`,
        },
      ]);
    } finally {
      setPending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit(draft);
  }

  return (
    <section
      aria-label="Assistant"
      className="flex min-h-[420px] flex-col overflow-hidden rounded-2xl border border-hl-line bg-hl-panel lg:min-h-0"
    >
      <div className="flex items-center justify-between gap-3 border-b border-hl-line-soft px-4 pt-4 pb-3">
        <h2 className="text-xs font-semibold tracking-[0.18em] text-hl-muted uppercase">
          Assistant
        </h2>
        <span className="text-[10px] text-hl-dim">answers cite their records</span>
      </div>

      <div ref={logRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !pending ? (
          <p className="rounded-2xl border border-hl-line-soft bg-hl-raised p-4 text-xs leading-relaxed text-hl-muted">
            Ask about shelters, closures or what has changed. Every answer restates
            verified records and shows where each one came from.
          </p>
        ) : null}

        {messages.map((message) => {
          if (message.role === "user") {
            return (
              <div key={message.id} className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-md bg-white px-3.5 py-2.5 text-xs leading-relaxed font-medium text-hl-bg">
                  {message.text}
                </p>
              </div>
            );
          }

          if (message.role === "error") {
            return (
              <p
                key={message.id}
                className="rounded-2xl border border-hl-red/30 bg-hl-red-soft/50 p-3.5 text-xs text-hl-red"
              >
                {message.text}
              </p>
            );
          }

          return <AnswerCard key={message.id} response={message.response} now={now} />;
        })}

        {pending ? <AnswerSkeleton /> : null}

        {routeNote ? (
          <p className="rounded-2xl border border-hl-amber/30 bg-hl-amber-soft/50 p-3 text-[11px] italic text-hl-amber">
            {routeNote}
          </p>
        ) : null}
      </div>

      <div className="border-t border-hl-line-soft px-4 pt-3 pb-4">
        {/* One compact scrollable row, and only while the chat is empty —
            once a conversation exists the user knows what to ask. */}
        {messages.length === 0 ? (
          <div className="scrollbar-none mb-2.5 flex gap-1.5 overflow-x-auto pb-0.5">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                disabled={pending}
                onClick={() => void submit(prompt)}
                className="inline-flex shrink-0 items-center rounded-full border border-hl-line bg-hl-raised px-3 py-1.5 text-[11px] whitespace-nowrap text-hl-muted transition-colors hover:text-white disabled:opacity-50"
              >
                {prompt}
              </button>
            ))}
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="flex items-center gap-2">
          <label htmlFor="assistant-input" className="sr-only">
            Ask the Harborline assistant
          </label>
          <input
            id="assistant-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about shelters, roads or changes…"
            autoComplete="off"
            className="min-h-11 flex-1 rounded-full border border-hl-line bg-hl-raised px-4 text-xs text-white placeholder:text-hl-dim"
          />
          <button
            type="submit"
            disabled={pending || draft.trim() === ""}
            className="inline-flex h-11 min-w-11 items-center justify-center rounded-full bg-white px-5 text-xs font-semibold text-hl-bg transition-opacity disabled:opacity-40"
          >
            {pending ? "…" : "Ask"}
          </button>
        </form>
      </div>
    </section>
  );
}

function AnswerCard({ response, now }: { response: AssistantResponse; now: Date }) {
  return (
    <article className="rounded-2xl border border-hl-line-soft bg-hl-raised p-4">
      <Markdown>{response.answer_markdown}</Markdown>

      {response.recommended_action ? (
        <div className="mt-3.5 rounded-xl border border-hl-teal/35 bg-hl-teal-soft/60 p-3">
          <p className="text-[10px] font-semibold tracking-[0.16em] text-hl-teal uppercase">
            Recommended action
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-white">
            {response.recommended_action}
          </p>
        </div>
      ) : null}

      {response.sources.length > 0 ? (
        <div className="mt-3.5 flex flex-wrap gap-2">
          {response.sources.map((source, index) => (
            <span
              key={`${source.provider}-${index}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-hl-line bg-hl-panel py-1 pr-3 pl-1.5 text-[10px] text-hl-muted"
            >
              <span
                className={[
                  "rounded-full border px-1.5 py-0.5 text-[9px] font-semibold",
                  tierBadgeClass(source.tier),
                ].join(" ")}
              >
                {source.tier}
              </span>
              {source.provider} · {formatAge(source.last_verified_at, now)}
            </span>
          ))}
        </div>
      ) : null}

      <p className="mt-3 text-[10px] text-hl-dim">
        {response.freshness_note}
        {response.composed_by === "llm" ? " · restated by model, evidence-bound" : ""}
      </p>

      {response.uncertainty_note ? (
        <p className="mt-2 text-[11px] italic text-hl-amber">
          {response.uncertainty_note}
        </p>
      ) : null}
    </article>
  );
}

function AnswerSkeleton() {
  return (
    <div
      className="animate-pulse rounded-2xl border border-hl-line-soft bg-hl-raised p-4"
      aria-label="Composing answer"
      role="status"
    >
      <div className="h-3 w-2/3 rounded-full bg-hl-line" />
      <div className="mt-2.5 h-3 w-full rounded-full bg-hl-line/70" />
      <div className="mt-2 h-3 w-5/6 rounded-full bg-hl-line/70" />
      <div className="mt-4 h-6 w-40 rounded-full bg-hl-line/60" />
    </div>
  );
}

export default AssistantPanel;
