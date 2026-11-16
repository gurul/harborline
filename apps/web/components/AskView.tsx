"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AssistantResponse, NearbyResource } from "@harborline/event-schema";
import { askAssistant } from "../lib/api";
import { formatAge, useNow } from "../lib/format";
import { serverAccessNeeds } from "../lib/preferences";
import { answerDestination } from "../lib/ranking";
import { useResources } from "../lib/queries";
import { usePrefersReducedMotion } from "../lib/useMediaQuery";
import { useAppState, type AnswerRoute } from "./AppState";
import { Markdown } from "./Markdown";
import { usePreferences } from "./Preferences";
import { Button, buttonClass } from "./ui";

const PROMPTS: { label: string; text: string }[] = [
  { label: "Shelter", text: "Where is the nearest open shelter?" },
  { label: "Roads", text: "Which roads should I avoid?" },
  { label: "Changes", text: "What changed in the last hour?" },
  { label: "Next step", text: "What should I do right now?" },
];

const MAX_QUESTION = 500;

type ChatMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "answer"; response: AssistantResponse }
  | { id: string; role: "error"; text: string; question: string };

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

export function AskView({ active }: { active: boolean }) {
  const { user, pendingQuestion, consumeQuestion, showAnswerRoute } = useAppState();
  const { preferences } = usePreferences();
  const resources = useResources(user.lat, user.lon).data?.resources ?? [];
  const now = useNow(30_000);
  const reducedMotion = usePrefersReducedMotion();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const lastRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    // Bring the start of the newest message into view: an answer leads with its action.
    lastRef.current?.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  }, [messages, pending, active, reducedMotion]);

  const submit = useCallback(
    async (question: string) => {
      const trimmed = question.trim().slice(0, MAX_QUESTION);
      if (!trimmed || pendingRef.current) return;
      pendingRef.current = true;
      setMessages((m) => [...m, { id: nextId("u"), role: "user", text: trimmed }]);
      setDraft("");
      setPending(true);
      try {
        const response = await askAssistant({
          question: trimmed,
          lat: user.lat,
          lon: user.lon,
          access_needs: serverAccessNeeds(preferences.needs),
        });
        setMessages((m) => [...m, { id: nextId("a"), role: "answer", response }]);
      } catch (err) {
        setMessages((m) => [
          ...m,
          {
            id: nextId("e"),
            role: "error",
            question: trimmed,
            text: `Could not reach Harborline (${err instanceof Error ? err.message : "network error"}). No answer is shown rather than an unverified one.`,
          },
        ]);
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [user.lat, user.lon, preferences.needs],
  );

  // Questions sent from elsewhere ("What should I do?" in the banner).
  useEffect(() => {
    if (!pendingQuestion) return;
    consumeQuestion(pendingQuestion.nonce);
    void submit(pendingQuestion.text);
  }, [pendingQuestion, consumeQuestion, submit]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(draft);
  }

  const empty = messages.length === 0 && !pending;

  function renderMessage(message: ChatMessage) {
    if (message.role === "user") {
      return (
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-[20px] rounded-br-md bg-white px-4 py-3 text-body text-hl-bg">
            <span className="sr-only">You asked: </span>
            {message.text}
          </p>
        </div>
      );
    }
    if (message.role === "error") {
      return (
        <div role="alert" className="flex flex-col gap-3 rounded-2xl bg-hl-red-soft p-4">
          <p className="text-body text-hl-severe">{message.text}</p>
          <div>
            <Button onClick={() => void submit(message.question)} disabled={pending}>
              Try again
            </Button>
          </div>
        </div>
      );
    }
    return (
      <AnswerCard
        response={message.response}
        now={now}
        destination={answerDestination(message.response, resources)}
        onRoute={(destination) =>
          showAnswerRoute(
            destination,
            (message.response as { route?: AnswerRoute | null }).route,
          )
        }
      />
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col gap-4 pb-4">
        {empty ? (
          <section aria-labelledby="prompts-heading" className="flex flex-col gap-3">
            <h2 id="prompts-heading" className="text-body text-white">
              Ask about shelters, roads or what changed. Every answer restates verified records and
              names its sources.
            </h2>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1">
              {PROMPTS.map((p) => (
                <li key={p.text}>
                  <button
                    type="button"
                    onClick={() => void submit(p.text)}
                    className="flex min-h-14 w-full flex-col justify-center rounded-xl bg-hl-panel px-4 py-3 text-left transition-colors hover:bg-hl-raised"
                  >
                    <span className="text-label font-medium text-hl-muted">{p.label}</span>
                    <span className="text-body text-white">{p.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div role="log" aria-live="polite" aria-label="Conversation" className="flex flex-col gap-4">
          {messages.map((message, index) => {
            const isLast = index === messages.length - 1;
            const content = renderMessage(message);
            return (
              <div key={message.id} ref={isLast ? lastRef : undefined} className="scroll-mt-4">
                {content}
              </div>
            );
          })}
          {pending ? (
            <p role="status" className="rounded-2xl bg-hl-panel p-4 text-body text-hl-muted">
              Checking records…
            </p>
          ) : null}
        </div>
      </div>

      <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 bg-hl-surface px-4 pt-3 pb-4">
        {!empty ? (
          <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1">
            {PROMPTS.map((p) => (
              <button
                key={p.text}
                type="button"
                disabled={pending}
                onClick={() => void submit(p.text)}
                className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-hl-control-edge bg-hl-panel px-4 text-meta whitespace-nowrap text-white hover:bg-hl-raised disabled:opacity-50"
              >
                {p.text}
              </button>
            ))}
          </div>
        ) : null}
        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <label htmlFor="ask-input" className="sr-only">
            Your question
          </label>
          <input
            id="ask-input"
            value={draft}
            maxLength={MAX_QUESTION}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about shelters, roads or changes"
            autoComplete="off"
            className="min-h-12 flex-1 rounded-lg border border-hl-control-edge bg-hl-raised px-4 text-body text-white placeholder:text-hl-muted"
          />
          <button
            type="submit"
            disabled={pending || draft.trim() === ""}
            className={buttonClass("primary", "min-w-16")}
          >
            Ask
          </button>
        </form>
      </div>
    </div>
  );
}

function AnswerCard({
  response,
  now,
  destination,
  onRoute,
}: {
  response: AssistantResponse;
  now: Date;
  destination: NearbyResource | null;
  onRoute: (r: NearbyResource) => void;
}) {
  return (
    <article className="flex flex-col gap-3 rounded-2xl bg-hl-panel p-4">
      {response.recommended_action ? (
        <div className="rounded-xl bg-hl-teal-soft p-3">
          <p className="text-meta font-medium text-hl-action">Recommended action</p>
          <p className="mt-1 text-body text-white">{response.recommended_action}</p>
          {destination ? (
            <div className="mt-3">
              <Button variant="action" onClick={() => onRoute(destination)}>
                Route to {destination.name}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <Markdown>{response.answer_markdown}</Markdown>

      {response.sources.length > 0 ? (
        <div>
          <h3 className="text-meta font-medium text-hl-muted">Sources</h3>
          <ul className="mt-1 flex flex-col gap-1">
            {response.sources.map((s, i) => (
              <li key={`${s.provider}-${i}`} className="text-meta text-white">
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                    {s.provider}
                  </a>
                ) : (
                  s.provider
                )}
                <span className="text-hl-muted">
                  {" "}
                  · tier {s.tier}
                  {s.tier === "A" ? " (official)" : ""} · {formatAge(s.last_verified_at, now)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-meta text-hl-muted">
        {response.freshness_note}
        {response.composed_by === "llm" ? " Restated by a language model from these records." : ""}
      </p>
      {response.uncertainty_note ? (
        <p className="text-meta text-hl-moderate">{response.uncertainty_note}</p>
      ) : null}
    </article>
  );
}
