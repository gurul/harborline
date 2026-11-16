"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Shared pieces of the one card pattern. Surfaces are separated by fill, not
 * borders; controls are at least 44 px tall (48 for primary actions).
 */

export type ButtonVariant = "primary" | "action" | "secondary" | "quiet";

const VARIANT: Record<ButtonVariant, string> = {
  // White fill: the default emphasis.
  primary: "min-h-12 bg-white text-hl-bg hover:bg-white/90",
  // Teal fill: route and recommended actions only.
  action: "min-h-12 bg-hl-teal text-hl-bg hover:bg-hl-teal/90",
  secondary:
    "min-h-11 border border-hl-control-edge bg-hl-raised text-white hover:bg-hl-line",
  quiet: "min-h-11 text-white underline-offset-4 hover:underline",
};

export function buttonClass(variant: ButtonVariant = "secondary", extra = ""): string {
  return [
    "inline-flex items-center justify-center gap-2 rounded-xl px-4 text-meta font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    VARIANT[variant],
    extra,
  ].join(" ");
}

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}

export function Card({
  children,
  className = "",
  as: Tag = "section",
  label,
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "article" | "div" | "li";
  label?: string;
}) {
  return (
    <Tag aria-label={label} className={["rounded-2xl bg-hl-panel p-4", className].join(" ")}>
      {children}
    </Tag>
  );
}

/** Section heading inside a view: sentence case, 14/500, muted. */
export function SectionHeading({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h2 id={id} className="text-meta font-medium text-hl-muted">
      {children}
    </h2>
  );
}

/** The one source-and-age line every value carries. */
export function SourceLine({
  children,
  warn = false,
  className = "",
}: {
  children: ReactNode;
  warn?: boolean;
  className?: string;
}) {
  return (
    <p className={["text-meta", warn ? "text-hl-moderate" : "text-hl-muted", className].join(" ")}>
      {children}
    </p>
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
