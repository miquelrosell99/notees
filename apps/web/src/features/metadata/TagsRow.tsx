import { useRef, useState } from "react";

import type { ClientNode } from "@/core/workspace-client/index.js";

import { labelFromClient } from "../../ui/dateDisplay.js";
import { Icon } from "../../ui/Icon.js";
import { AddPill } from "../../components/ui/fleet/AddPill.js";
import { NodeSelector } from "../pickers/NodeSelector.js";
import { NodeContextMenu } from "../node-menu/NodeContextMenu.js";
import type { AnyClient } from "./shared.js";
import { contrastFor } from "./shared.js";
import { cssColorFor } from "../../components/ui/fleet/colorPresets.js";

/**
 * TagsRow — the "Tags:" metadata row (pages and blocks): any page can be
 * assigned as a tag. Pills mirror the classes row; right-click opens the
 * node menu (remove goes through unassignTag).
 */
export function TagsRow({
  client,
  nodeId,
  tagIds,
  onOpenPage,
  /** Read-only projection: static pills — open on click, no add/remove. */
  readOnly = false,
}: {
  client: AnyClient;
  nodeId: string;
  tagIds: string[];
  onOpenPage?: ((pageId: string) => void) | undefined;
  readOnly?: boolean | undefined;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [nodeMenu, setNodeMenu] = useState<{ node: ClientNode; x: number; y: number } | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  // Tags render alphabetically everywhere (owner rule): order by display name.
  const assignedTags = [...tagIds]
    .sort((a, b) =>
      (labelFromClient(client, a) ?? "Untitled").localeCompare(
        labelFromClient(client, b) ?? "Untitled",
      ),
    )
    .map((tagId) => client.getNode(tagId))
    .filter((node): node is ClientNode => node !== undefined);

  return (
    <div className="node-metadata-row nt-tags-row">
      <div className="section-label">Tags:</div>
      <div className="nt-property-chips node-metadata-pills">
        {assignedTags.map((tag) => {
          const label = labelFromClient(client, tag.id) ?? "Untitled";
          // Pill chrome like classes: grey surface by default, the tag's
          // effectiveColor (own, else its classes') as the background when set.
          const colored = client.effectiveNodeColor(tag);
          return (
            <span
              key={tag.id}
              className="pill pill--hover-reveal-right"
              style={
                colored !== null
                  ? { background: cssColorFor(colored), color: contrastFor(colored) }
                  : undefined
              }
              onContextMenu={
                readOnly
                  ? undefined
                  : (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setNodeMenu({ node: tag, x: event.clientX, y: event.clientY });
                    }
              }
            >
              {tag.icon !== null && (
                <span className="pill__left-icon">
                  <Icon path={tag.icon} size={0.7} />
                </span>
              )}
              <button
                type="button"
                className="pill__text"
                onClick={() => onOpenPage?.(tag.id)}
              >
                {label}
              </button>
              {!readOnly && (
                <button
                  type="button"
                  className="pill__right-button"
                  aria-label={`Remove tag ${label}`}
                  onClick={() => void client.unassignTag(nodeId, tag.id)}
                >
                  <Icon path="mdi-close" size={0.6} />
                </button>
              )}
            </span>
          );
        })}
        {!readOnly && (
          <span className="nt-class-add-anchor">
            <AddPill
              ref={addButtonRef}
              className={tagIds.length > 0 ? "pill--icon-only" : ""}
              label="Add tag"
              aria-expanded={pickerOpen}
              onClick={(element) => {
                addButtonRef.current = element;
                setPickerOpen(true);
              }}
            />
          </span>
        )}
      </div>
      {pickerOpen && (
        <NodeSelector
          client={client}
          anchorEl={addButtonRef.current}
          searchMode="pages"
          nodes={assignedTags}
          excludeNodeId={nodeId}
          alwaysShowCreate
          searchPlaceholder="Search pages…"
          onClose={() => setPickerOpen(false)}
          onAdd={(node) => {
            setPickerOpen(false);
            void client.assignTag(nodeId, node.id);
          }}
        />
      )}
      <NodeContextMenu
        state={nodeMenu === null ? null : { ...nodeMenu, ownerId: nodeId, isPage: true }}
        client={client}
        onClose={() => setNodeMenu(null)}
        onOpenNode={(id) => onOpenPage?.(id)}
        onRemoveFromOwner={() => {
          if (nodeMenu !== null) void client.unassignTag(nodeId, nodeMenu.node.id);
        }}
      />
    </div>
  );
}
