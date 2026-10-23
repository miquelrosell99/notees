/**
 * NodeResultItem — shared node result row for the node-picker popups.
 *
 * Renders a single selectable node with an optional breadcrumb path above and
 * an icon + name row. Shared by the metadata pickers (and any other component
 * that presents a searchable list of nodes).
 */

import { Icon } from "../../ui/Icon.js";
import { fullTitleForSettings, nodeDisplayName } from "../../ui/dateDisplay.js";
import type { ClientNode } from "@/core/workspace-client/index.js";
import "./NodeResultItem.css";

export interface NodeResultItemProps {
  node: ClientNode | { name: string };
  /**
   * Fresh-row read surface: when present, a node row's label + tooltip
   * re-read the node via the scope-classed getNode and derive the title
   * from THAT row — the pooled listings (listPages and friends) are
   * structure-classed cached reads, so a pooled node's own contentAst can
   * lag a rename. Pseudo-rows (`{ name }` only) render unchanged.
   */
  client?: {
    getNode(id: string): ClientNode | undefined;
  };
  /** Pre-computed ancestor breadcrumb string, e.g. "Root / Parent" */
  parentPath?: string;
  /** Pre-computed display classes (excluding system page class) */
  displayClasses?: Array<{ nodeUuid: string; name: string }>;
  /** Whether this row is keyboard-highlighted */
  isHighlighted?: boolean;
  /** Whether this item is already selected — renders a checkmark */
  isSelected?: boolean;
  onClick: () => void;
  onCtrlClick?: () => void;
  onMouseEnter?: () => void;
  /** Extra CSS classes on the root button */
  className?: string;
  /** Slot rendered after the name (e.g. an alias badge) */
  after?: React.ReactNode;
  /** Override the default node icon (e.g. a calendar icon for date suggestions) */
  iconOverride?: React.ReactNode;
}

/**
 * The row's line + tooltip titles: the capped display name and the uncapped
 * full title, both derived from the FRESH per-node read when a client is
 * present (the pooled listings are structure-classed cached reads, so a
 * pooled node's own contentAst can lag a rename) and from the pooled row
 * otherwise. Pseudo-rows (`{ name }` only) render their label unchanged.
 */
function rowTitles(
  node: ClientNode | { name: string },
  client: { getNode(id: string): ClientNode | undefined } | undefined,
): { lineName: string; fullName: string } {
  if (!("id" in node)) return { lineName: node.name, fullName: node.name };
  const titleNode = client?.getNode(node.id) ?? node;
  return {
    lineName: nodeDisplayName(titleNode) || node.id,
    fullName: fullTitleForSettings(titleNode) || node.id,
  };
}

export function NodeResultItem({
  node,
  client = undefined,
  parentPath,
  displayClasses,
  isHighlighted = false,
  isSelected = false,
  onClick,
  onCtrlClick,
  onMouseEnter,
  className = "",
  after,
  iconOverride,
}: NodeResultItemProps) {
  const icon = "icon" in node && node.icon !== null ? node.icon : null;
  // A node row re-reads fresh through `client` (scope-classed getNode) and
  // falls back to the pooled row when the fresh read misses (e.g. an
  // archived node the live read filters out). The row crops the name (CSS
  // ellipsis); the hover tooltip shows the SAME string uncropped: the line
  // renders the capped display name, but the tooltip rides the UNCAPPED
  // full-title funnel (fullTitleForSettings — the read-mode link
  // derivation): for any title inside the display-name budget it is
  // byte-identical to the line, and past it the tooltip keeps the whole
  // title instead of an 80-char cut — a link must read as the page's whole
  // title (the crumbs above ride the same title idiom).
  const { lineName, fullName } = rowTitles(node, client);
  return (
    <button
      type="button"
      className={`node-result-item${isHighlighted ? " node-result-item--highlighted" : ""}${className ? ` ${className}` : ""}`}
      onClick={(e) => {
        if ((e.ctrlKey || e.metaKey) && onCtrlClick) {
          e.preventDefault();
          onCtrlClick();
        } else {
          onClick();
        }
      }}
      onMouseEnter={onMouseEnter}
    >
      {parentPath && (
        <div className="node-result-item__crumbs" title={parentPath}>
          {parentPath}
        </div>
      )}
      <div className="node-result-item__row">
        <span className="node-result-item__icon">
          {iconOverride ?? (icon !== null ? <Icon path={icon} size={0.7} /> : null)}
        </span>
        <span className="node-result-item__name" title={fullName}>
          {lineName}
        </span>
        {displayClasses && displayClasses.length > 0 && (
          <span className="node-result-item__class-pills">
            {displayClasses.map((cls) => (
              <span key={cls.nodeUuid} className="node-result-item__class-pill">
                {cls.name}
              </span>
            ))}
          </span>
        )}
        {after}
        {isSelected && (
          <span className="node-result-item__check">
            <Icon path="mdi-check" size={0.55} />
          </span>
        )}
      </div>
    </button>
  );
}
