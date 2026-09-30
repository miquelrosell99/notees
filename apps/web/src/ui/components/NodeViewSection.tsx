/**
 * NodeViewSection — the shared collapsible-section chrome, a faithful port
 * mechanism). Used by the Metadata section and the system sections
 * (Linked references / Child pages / Unlinked references).
 *
 * here the whole header is a single <button> so its accessible name is the
 * title + count (keyboard- and test-friendly) and no interactive element
 * nests inside another. Supports controlled and uncontrolled expansion
 * (controlled is used by Section, which must observe expands to run its
 * lazy query).
 */

import { useState, type ReactNode } from "react";

import { Icon } from "../Icon.js";
import "./NodeViewSection.css";

export interface NodeViewSectionProps {
  title: string;
  icon?: ReactNode;
  count?: number | undefined;
  /** Uncontrolled initial state. */
  defaultExpanded?: boolean;
  /** Controlled expansion state (with onExpandedChange). */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  children: ReactNode;
  className?: string;
}

export function NodeViewSection({
  title,
  icon,
  count,
  defaultExpanded = true,
  expanded,
  onExpandedChange,
  children,
  className = "",
}: NodeViewSectionProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const isExpanded = expanded ?? internalExpanded;

  const toggle = () => {
    if (expanded !== undefined) {
      onExpandedChange?.(!expanded);
    } else {
      setInternalExpanded((prev) => !prev);
    }
  };

  return (
    <section
      className={`node-view-section ${isExpanded ? "expanded" : "collapsed"} ${className}`.trim()}
    >
      <button
        type="button"
        className="node-view-section__header"
        aria-expanded={isExpanded}
        onClick={toggle}
      >
        <span className="node-view-section__toggle" aria-hidden="true">
          <Icon path="mdi-chevron-right" size={0.9} className="node-view-section__chevron" />
        </span>
        <span className="node-view-section__title-area">
          {icon && <span className="node-view-section__icon">{icon}</span>}
          <span className="node-view-section__title">{title}</span>
          {count !== undefined && <span className="node-view-section__count">{count}</span>}
        </span>
      </button>
      {isExpanded && <div className="node-view-section__content">{children}</div>}
    </section>
  );
}
