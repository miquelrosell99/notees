/**
 * NodeResultItem — shared node result row for the node-picker popups.
 *
 * Renders a single selectable node with an optional breadcrumb path above and
 * an icon + name row. Shared by the metadata pickers (and any other component
 * that presents a searchable list of nodes).
 */

import { ListRow } from "../../components/ui/fleet/index.js";
import { Icon } from "../../ui/Icon.js";
import { titleOfNode } from "../../ui/dateDisplay.js";
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
   * `getDisplayName`, when present, powers the chrome flatten: bare mentions
   * and class chips resolve their target's CURRENT name (the wire stores no
   * link text — without it a mention contributes nothing to the flattened
   * label).
   */
  client?: {
    getNode(id: string): ClientNode | undefined;
    getDisplayName?(id: string): string | null;
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
  client: { getNode(id: string): ClientNode | undefined; getDisplayName?(id: string): string | null } | undefined,
): { lineName: string; fullName: string } {
  if (!("id" in node)) return { lineName: node.name, fullName: node.name };
  const titleNode = client?.getNode(node.id) ?? node;
  // The chrome flatten (the dense-row idiom — markdown spans reduced to
  // their label, chips and mentions resolved to their CURRENT names): a
  // bare mention stores no text of its own, so without the resolvers its
  // label reads as a hole in the row ("…de la ?").
  const resolve = client?.getDisplayName?.bind(client);
  const chrome = {
    flatten: "chrome",
    resolveClassName: resolve,
    resolveMentionName: resolve,
  } as const;
  return {
    lineName: titleOfNode(titleNode, chrome) || node.id,
    fullName: titleOfNode(titleNode, { ...chrome, budget: "full" }) || node.id,
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
  // full-title funnel (titleOfNode budget "full" — the read-mode link
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
      <ListRow
        className="node-result-item__row"
        leading={iconOverride ?? (icon !== null ? <Icon path={icon} size={0.7} /> : <span />)}
        primary={<span title={fullName}>{lineName}</span>}
        trailing={
          <>
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
          </>
        }
      />
    </button>
  );
}
