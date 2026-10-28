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
 * which must observe expands to run its lazy query). `hideToggle` renders
 * the header as INERT chrome (no chevron, not a button) for hosts that own
 * show/hide themselves — the block backlink card's gutter toggle (hiding a
 * collapse affordance on a surface the user can dismiss entirely); the
 * empty toggle slot stays so the title and content keep their alignment.
 * The header carries an
 * OPTIONAL count badge — the count's home on sections WITHOUT hosted tabs
 * (* one count semantics everywhere: displayed nodes, named exactly once).
 */

import { useState, type ReactNode } from "react";

import { Icon } from "../../ui/Icon.js";
import { Badge } from "../../components/ui/fleet/Badge.js";
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
  /**
   * Hide the collapse toggle: the header renders as inert chrome (no
   * chevron, not a button) and the section keeps its current expansion
   * state — for hosts that own show/hide themselves (the block backlink
   * card's gutter toggle: collapsing a surface the user can hide entirely
   * makes no sense).
   */
  hideToggle?: boolean | undefined;
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
  hideToggle = false,
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

  const titleArea = (
    <span className="node-view-section__title-area">
      {icon && <span className="node-view-section__icon">{icon}</span>}
      <span className="node-view-section__title">{title}</span>
      {count !== undefined && <Badge className="node-view-section__count" size="sm">{count}</Badge>}
    </span>
  );

  return (
    <section
      className={`node-view-section ${isExpanded ? "expanded" : "collapsed"} ${className}`.trim()}
    >
      <div className="node-view-section__header-row">
        {hideToggle ? (
          /* Inert header: the empty toggle slot keeps the title (and the
             spacing-7 content indent) aligned with the collapsible form. */
          <div className="node-view-section__header node-view-section__header--static">
            <span className="node-view-section__toggle" aria-hidden="true" />
            {titleArea}
          </div>
        ) : (
          <button
            type="button"
            className="node-view-section__header"
            aria-expanded={isExpanded}
            onClick={toggle}
          >
            <span className="node-view-section__toggle" aria-hidden="true">
              <Icon path="mdi-chevron-right" size={0.9} className="node-view-section__chevron" />
            </span>
            {titleArea}
          </button>
        )}
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
