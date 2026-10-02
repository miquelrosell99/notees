/**
 * ViewToolbar — the right-aligned chrome row that hosts a ViewSwitcher
 * (and, as surfaces grow, per-view settings controls). Rendered as a sibling
 * of section headers — never nested inside the NodeViewSection header
 * button, which stays one accessible element.
 */

import type { ReactNode } from "react";

import { ViewSwitcher } from "./ViewSwitcher.js";
import type { ViewMode } from "./types.js";
import "./ViewToolbar.css";

export interface ViewToolbarProps {
  modes: ViewMode[] | string[];
  value: ViewMode | string;
  onChange: (mode: ViewMode) => void;
  /** Extra controls left of the switcher (filters, add buttons, …). */
  children?: ReactNode;
  className?: string;
}

export function ViewToolbar({ modes, value, onChange, children, className = "" }: ViewToolbarProps) {
  return (
    <div className={`view-toolbar ${className}`.trim()}>
      {children}
      <ViewSwitcher modes={modes} value={value} onChange={onChange} />
    </div>
  );
}
