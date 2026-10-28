/**
 * CollapsibleSearchField — the search box that folds into its row. Collapsed
 * it rides the chrome row as a ghost magnifier button (the row's icons keep
 * their seats); clicking it expands the SearchField pill IN FLOW — not an
 * anchored popup — and the caret lands in the input (the expand mounts the
 * field with autoFocus). The pill's trailing × folds it back: with text
 * present the × CLEARS first (one affordance, one click per intent — the
 * aria label names the current action, "Clear search" vs "Close search"),
 * with the field empty the × collapses. Escape folds it from the keyboard.
 * The collapsed button carries the `active` state while a value hides in the
 * folded field, so a live filter stays legible.
 *
 * Composed from kit primitives only (Button + SearchField): the × reuses the
 * SearchField clear lane's `search-field__clear` geometry through
 * SearchField's `trailing` slot — the pill owns the × hit area, a sibling
 * outside the lane would break the grid. The component renders NO wrapper:
 * the folded button or the pill joins the host row's flex line directly —
 * the host caps the pill's width through its own class.
 */

import { useState } from "react";

import { Icon } from "../../../ui/Icon.js";
import { Button } from "./Button.js";
import { SearchField } from "./SearchField.js";
import { cn } from "./cn.js";

export interface CollapsibleSearchFieldProps {
  /** The current text (controlled). */
  value: string;
  onChange: (value: string) => void;
  /** Clear affordance — defaults to onChange(""). */
  onClear?: (() => void) | undefined;
  /** Pill size (default "sm" — toolbar rows). */
  size?: "sm" | "md" | undefined;
  placeholder?: string | undefined;
  /** The expanded input's accessible name. */
  "aria-label"?: string | undefined;
  /** The collapsed toggle's accessible name. */
  toggleLabel?: string | undefined;
  /** Additional class on the pill (or the folded button) — the host's flex rule rides it. */
  className?: string | undefined;
}

export function CollapsibleSearchField({
  value,
  onChange,
  onClear,
  size = "sm",
  placeholder,
  "aria-label": ariaLabel = "Filter by text",
  toggleLabel = "Search rows",
  className,
}: CollapsibleSearchFieldProps) {
  const [expanded, setExpanded] = useState(false);
  const hasValue = value !== "";

  if (!expanded) {
    return (
      <Button
        type="button"
        variant="ghost"
        size={size}
        icon="mdi mdi-magnify"
        aria-label={toggleLabel}
        title={toggleLabel}
        aria-pressed={hasValue}
        active={hasValue}
        onClick={() => setExpanded(true)}
      />
    );
  }

  return (
    <SearchField
      className={cn("collapsible-search-field", className)}
      size={size}
      aria-label={ariaLabel}
      placeholder={placeholder}
      autoFocus
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setExpanded(false);
        }
      }}
      trailing={
        <button
          type="button"
          className="search-field__clear relative inline-flex cursor-pointer items-center justify-center rounded-full border-none bg-transparent p-0 text-on-surface-variant hover:bg-hover-overlay hover:text-on-surface"
          aria-label={hasValue ? "Clear search" : "Close search"}
          title={hasValue ? "Clear search" : "Close search"}
          onClick={() => {
            if (hasValue) {
              if (onClear !== undefined) onClear();
              else onChange("");
            } else {
              setExpanded(false);
            }
          }}
        >
          <Icon path="mdi mdi-close" size="sm" />
        </button>
      }
    />
  );
}
