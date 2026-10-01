/**
 * NodeResultItem — shared node result row for the node-picker popups.
 *
 * Renders a single selectable node with an optional breadcrumb path above and
 * an icon + name row. Shared by the metadata pickers (and any other component
 * that presents a searchable list of nodes).
 */

import { Icon } from "../../Icon.js";
import { displayNameForSettings } from "../../dateDisplay.js";
import type { ClientNode } from "@/core/workspace-client.js";
import "./NodeResultItem.css";

export interface NodeResultItemProps {
  node: ClientNode | { name: string };
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
  /** Slot rendered before the icon (e.g. a Checkbox in multi-select mode) */
  before?: React.ReactNode;
  /** Slot rendered after the name (e.g. an alias badge) */
  after?: React.ReactNode;
  /** Override the default node icon (e.g. a calendar icon for date suggestions) */
  iconOverride?: React.ReactNode;
}

export function NodeResultItem({
  node,
  parentPath,
  displayClasses,
  isHighlighted = false,
  isSelected = false,
  onClick,
  onCtrlClick,
  onMouseEnter,
  className = "",
  before,
  after,
  iconOverride,
}: NodeResultItemProps) {
  const icon = "icon" in node && node.icon !== null ? node.icon : null;
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
        {before}
        <span className="node-result-item__icon">
          {iconOverride ?? (icon !== null ? <Icon path={icon} size={0.7} /> : null)}
        </span>
        <span className="node-result-item__name">
          {"id" in node ? displayNameForSettings(node as ClientNode) || node.id : node.name}
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
