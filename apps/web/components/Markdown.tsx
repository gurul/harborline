"use client";

import { Fragment, type ReactNode } from "react";

/**
 * A deliberately tiny markdown renderer.
 *
 * The assistant's answer is composed from structured evidence, so the surface
 * it needs is small: headings, paragraphs, lists, bold, italic and inline code.
 * Nothing here interprets raw HTML — text is always rendered as text.
 */

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "numbers"; items: string[] };

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE_PATTERN).filter((part) => part !== "");
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={key} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={key}
          className="rounded bg-hl-raised px-1 py-0.5 font-mono text-[0.95em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let numbers: string[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
    if (bullets.length > 0) {
      blocks.push({ kind: "bullets", items: bullets });
      bullets = [];
    }
    if (numbers.length > 0) {
      blocks.push({ kind: "numbers", items: numbers });
      numbers = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flush();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2],
      });
      continue;
    }

    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet?.[1] !== undefined) {
      if (paragraph.length > 0 || numbers.length > 0) {
        const held = bullets;
        bullets = [];
        flush();
        bullets = held;
      }
      bullets.push(bullet[1]);
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered?.[1] !== undefined) {
      if (paragraph.length > 0 || bullets.length > 0) {
        const held = numbers;
        numbers = [];
        flush();
        numbers = held;
      }
      numbers.push(numbered[1]);
      continue;
    }

    if (bullets.length > 0 || numbers.length > 0) flush();
    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

export function Markdown({ children }: { children: string }) {
  const blocks = parseBlocks(children);

  return (
    <div className="space-y-2.5 text-xs leading-relaxed text-hl-muted">
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        switch (block.kind) {
          case "heading":
            return (
              <p
                key={key}
                className={[
                  "font-semibold text-white",
                  block.level === 1 ? "text-sm" : "text-xs",
                ].join(" ")}
              >
                {renderInline(block.text, key)}
              </p>
            );
          case "bullets":
            return (
              <ul key={key} className="list-disc space-y-1 pl-4 marker:text-hl-dim">
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </ul>
            );
          case "numbers":
            return (
              <ol key={key} className="list-decimal space-y-1 pl-4 marker:text-hl-dim">
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </ol>
            );
          case "paragraph":
          default:
            return <p key={key}>{renderInline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}

export default Markdown;
