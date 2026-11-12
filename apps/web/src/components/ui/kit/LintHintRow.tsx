/**
 * LintHintRow — the suggestion-only lint hint (dashed chrome).
 *
 * A quiet, non-blocking nudge rendered inside a surface's chrome when a
 * lint's condition holds (the synthesis-evidence lint is the first
 * carrier). The dashed border reads as "advisory, not enforcement": the
 * row carries NO action, NO dismiss, and NEVER writes — role="status"
 * announces it to assistive tech (status IS a polite live region; an
 * explicit aria-live would be redundant) without stealing focus.
 */

import type { ReactNode } from "react";

import { Icon } from "../../../ui/Icon.js";
import { cn } from "@/utils/cn.js";
import "./LintHintRow.css";

export interface LintHintRowProps {
  /** The hint text — a suggestion, never an imperative block. */
  children: ReactNode;
  /** Leading icon (MDI path); defaults to the outline lightbulb. */
  icon?: string | undefined;
  className?: string;
}

export function LintHintRow({ children, icon = "mdi-lightbulb-outline", className }: LintHintRowProps) {
  return (
    <div className={cn("lint-hint-row", className)} role="status">
      <Icon path={icon} className="lint-hint-row__icon" />
      <span className="lint-hint-row__text">{children}</span>
    </div>
  );
}
