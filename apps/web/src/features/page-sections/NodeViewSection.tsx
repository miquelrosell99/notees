/**
 * NodeViewSection — the shared collapsible-section chrome, a faithful port
 * mechanism). Used by the Metadata section and the system sections
 * (Linked references / Child pages / Unlinked references).
 *
 * here the header is a header ROW: the collapse toggle is a <button> whose
 * accessible name is the title + count (keyboard- and test-friendly), and
 * an optional ACTION rides its far right — an icon-only button (the
 * section-scoped create affordance: add a comment, a child page, a class
 * member) rendered as a sibling, never nested in the toggle. Supports
 * controlled and uncontrolled expansion (controlled is used by Section,
 * which must observe expands to run its lazy query). The header carries an
 * OPTIONAL count badge — the count's home on sections WITHOUT hosted tabs
 * (owner refinement 2026-10-23 of the 2026-10-21 ruling: hosted sections
 * name the number dynamically on the active tab's badge and keep the
 * header bare; a section with tabs disabled names it in the header —
 * one count semantics everywhere: displayed nodes, named exactly once).
 */

import { useState, type ReactNode } from "react";

import { Icon } from "../../ui/Icon.js";
import "./NodeViewSection.css";

/** The header's trailing icon-only action (the section-scoped create). */
export interface NodeViewSectionAction {
  /** MDI icon name (the Icon component's resolver forms accepted). */
  icon: string;
  /** Accessible name + tooltip. */
  label: string;
  onClick: () => void;
}

export interface NodeViewSectionProps {
  title: string;
  icon?: ReactNode;
  /**
   * The header count badge — the count's home when the section has no
   * hosted tabs (the active tab's badge names it there instead; a section
   * names its count exactly once, never both).
   */
  count?: number | undefined;
  /** The header's far-right icon-only action (a create affordance). */
  action?: NodeViewSectionAction | undefined;
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
  action,
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
      <div className="node-view-section__header-row">
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
        {action !== undefined && (
          <button
            type="button"
            className="node-view-section__action"
            aria-label={action.label}
            title={action.label}
            onClick={action.onClick}
          >
            <Icon path={action.icon} size={0.85} />
          </button>
        )}
      </div>
      {isExpanded && <div className="node-view-section__content">{children}</div>}
    </section>
  );
}
