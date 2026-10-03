/**
 * ViewTabs — §34.31 V1: the saved-views chrome for a section whose saved
 * views are the `query` content tokens on an owner node. Each token is one
 * tab (its §34.31 V3 view-record title, else the positional "Query N"); the
 * tab order IS the token order in the content stream, so reordering tabs
 * reorders tokens (one content update), and every mutation rides the normal
 * content path — saved views sync like any other content, no view entity, no
 * new op.
 *
 * Per-tab menu: Rename (inline), Duplicate, Set/Clear default (§34.31 V13 —
 * the section's default view is configuration in the record, not code),
 * Move left/right, Delete (confirmation). Composes the Tabs/ContextMenu/
 * ConfirmationModal/TextField primitives.
 */

import { useEffect, useRef, useState } from "react";

import { ConfirmationModal, ContextMenu, Tabs, TextField } from "./ui/index.js";
import type { ContextMenuItem } from "./ui/index.js";

import { parseQueryViewRecord, queryViewTitle } from "../queryViewRecord.js";
import {
  duplicateQueryToken,
  listQueryTokens,
  moveQueryToken,
  patchTokenView,
  removeQueryToken,
  setDefaultQueryToken,
  type TokenWriteClient,
} from "../queryTokens.js";

export interface ViewTabsProps {
  /** Reads + writes (the content update path) + the notify subscription. */
  client: TokenWriteClient & { subscribe(listener: () => void): () => void };
  /** The node whose contentAst holds the saved-view tokens. */
  ownerId: string;
  /** The selected token index, or null when nothing is selected. */
  activeIndex: number | null;
  onSelect: (index: number) => void;
  /** Called after a reorder so the host can follow its selection. */
  onReordered?: ((fromIndex: number, toIndex: number) => void) | undefined;
}

export function ViewTabs({ client, ownerId, activeIndex, onSelect, onReordered }: ViewTabsProps) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleting, setDeleting] = useState<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const owner = client.getNode(ownerId);
  const tokens = owner === undefined ? [] : listQueryTokens(owner.contentAst as readonly unknown[]);
  if (tokens.length === 0) return null;

  const titleOf = (index: number): string => queryViewTitle(tokens.find((t) => t.index === index)?.view, positionOf(index));
  const positionOf = (index: number): number => tokens.findIndex((t) => t.index === index);

  const closeMenu = () => {
    setMenuFor(null);
    setMenuAnchor(null);
  };

  const openMenu = (index: number, anchor: HTMLElement) => {
    setMenuFor(index);
    setMenuAnchor(anchor);
  };

  const startRename = (index: number) => {
    const position = positionOf(index);
    setRenaming(index);
    setRenameDraft(queryViewTitle(tokens[position]?.view, position));
    closeMenu();
  };

  const commitRename = async () => {
    if (renaming !== null) {
      const trimmed = renameDraft.trim();
      await patchTokenView(client, ownerId, renaming, { title: trimmed === "" ? null : trimmed });
    }
    setRenaming(null);
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const from = positionOf(index);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= tokens.length) return;
    await moveQueryToken(client, ownerId, index, tokens[to]!.index);
    onReordered?.(from, to);
    closeMenu();
  };

  const menuItems: ContextMenuItem[] =
    menuFor === null
      ? []
      : (() => {
          const position = positionOf(menuFor);
          const isDefault = parseQueryViewRecord(tokens[position]?.view).isDefault;
          return [
            { id: "rename", label: "Rename…", onClick: () => startRename(menuFor) },
            {
              id: "duplicate",
              label: "Duplicate",
              onClick: () => {
                void duplicateQueryToken(client, ownerId, menuFor, `${titleOf(menuFor)} copy`);
                closeMenu();
              },
            },
            {
              id: "default",
              label: isDefault ? "Clear default" : "Set as default",
              onClick: () => {
                if (isDefault) void patchTokenView(client, ownerId, menuFor, { isDefault: false });
                else void setDefaultQueryToken(client, ownerId, menuFor);
                closeMenu();
              },
            },
            { id: "move-left", label: "Move left", disabled: position <= 0, onClick: () => void handleMove(menuFor, -1) },
            {
              id: "move-right",
              label: "Move right",
              disabled: position >= tokens.length - 1,
              onClick: () => void handleMove(menuFor, 1),
            },
            { id: "sep-delete", label: "", separator: true },
            {
              id: "delete",
              label: "Delete",
              danger: true,
              onClick: () => {
                setDeleting(menuFor);
                closeMenu();
              },
            },
          ];
        })();

  return (
    <div className="nt-view-tabs">
      <Tabs
        value={activeIndex === null ? "" : String(activeIndex)}
        onChange={(value) => onSelect(Number(value))}
      >
        <Tabs.List className="nt-view-tabs-list">
          {tokens.map((token) => {
            const position = positionOf(token.index);
            const isRenaming = renaming === token.index;
            const isDefault = parseQueryViewRecord(token.view).isDefault;
            return (
              <span key={token.index} className="nt-view-tab">
                {isRenaming ? (
                  <TextField
                    ref={renameInputRef}
                    autoFocus
                    size="sm"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void commitRename();
                      if (event.key === "Escape") setRenaming(null);
                    }}
                    onBlur={() => void commitRename()}
                  />
                ) : (
                  <Tabs.Tab
                    value={String(token.index)}
                    className={activeIndex === token.index ? "nt-view-tab-label-active" : ""}
                  >
                    {queryViewTitle(token.view, position)}
                    {isDefault && (
                      <span className="nt-view-tab-default" title="Default view" aria-label="Default view">
                        ●
                      </span>
                    )}
                  </Tabs.Tab>
                )}
                {!isRenaming && (
                  <button
                    type="button"
                    className="nt-view-tab-menu"
                    aria-label={`${queryViewTitle(token.view, position)} options`}
                    onClick={(event) => openMenu(token.index, event.currentTarget)}
                  >
                    ⋯
                  </button>
                )}
              </span>
            );
          })}
        </Tabs.List>
      </Tabs>
      {menuFor !== null && (
        <ContextMenu items={menuItems} anchorEl={menuAnchor} onClose={closeMenu} alignRight />
      )}
      {deleting !== null && (
        <ConfirmationModal
          isOpen
          title="Delete saved view"
          message={`Delete “${titleOf(deleting)}”? The query stops being a saved view; nothing else is touched.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => {
            void removeQueryToken(client, ownerId, deleting);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
