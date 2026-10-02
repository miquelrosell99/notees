/**
 * ViewSwitcher — the view-mode switcher: an icon strip over the kit
 * SelectionButton (maxVisibleOptions + "…" overflow dropdown is the
 * primitive's behavior; the dropdown rows show icon + label, the strip
 * shows icons only, with tooltips). Mode metadata (icon/label) comes from
 * the view registry, so the switcher never hard-codes a mode list.
 */

import { useMemo } from "react";

import { SelectionButton, type SelectionButtonOption } from "../components/ui/index.js";
import { getViewModeOptions } from "./registry.js";
import type { ViewMode } from "./types.js";

export interface ViewSwitcherProps {
  /** Available modes (registry ids), in display order. */
  modes: ViewMode[] | string[];
  value: ViewMode | string;
  onChange: (mode: ViewMode) => void;
  className?: string;
}

export function ViewSwitcher({ modes, value, onChange, className = "" }: ViewSwitcherProps) {
  const options = useMemo<SelectionButtonOption[]>(
    () => getViewModeOptions(modes).map((opt) => ({ value: opt.mode, icon: opt.icon, label: opt.label })),
    [modes],
  );
  if (options.length === 0) return null;
  return (
    <SelectionButton
      options={options}
      value={value}
      onChange={(val) => onChange(val as ViewMode)}
      size="sm"
      maxVisibleOptions={4}
      aria-label="View mode"
      className={`view-switcher ${className}`.trim()}
    />
  );
}
