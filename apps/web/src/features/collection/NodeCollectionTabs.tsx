/**
 * NodeCollectionTabs — the hosted-views chrome (the custom-tabs tab bar riding
 * WITH a hosted NodeCollection):
 *
 *  - the DEFAULT tab renders the surface's factory behavior — permanent,
 *    first, never closable, never replaced;
 *  - custom tabs are additive, ordered by sequence, each refining the base
 *    row set with its stored query_ast (sectionViewResolve);
 *  - "+" CREATES THE TAB IMMEDIATELY: the new tab persists the host's current draft AST (the bar's
 *    composed group, or the factory AST the host falls back to when the
 *    draft is empty) under an auto label and is selected. The query builder
 *    is NOT opened here — it is toggled per tab in the bar below, where its
 *    commit rewrites the SELECTED tab's query (the default tab's host writes
 *    its own default AST; a custom tab writes the view row via
 *    updateSectionViewAst);
 *  - the "+" rides the TABLIST's END (the
 *    right-cluster experiment placed it with the filter/view buttons and
 *    the owner brought it back beside the tabs): the LAST item of the tab
 *    strip, the classic new-tab position. The other chrome — the reset,
 *    the host section's `trailing` (the view switcher, the bar's quick
 *    search + structured toggle) — rides the bar's FAR RIGHT.
 *    Ordering contract: the bar renders LAST in the cluster so its
 *    structured panel wraps a full-width line BENEATH the row without
 *    moving the other controls;
 *  - the active tab carries a TOTAL COUNT badge beside its name (the resolved row count of the open tab, replacing
 *    the filter panel's "N of M nodes match" foot line): visual only,
 *    `aria-hidden`, so the tab's accessible name stays the bare label;
 *  - the active custom tab carries its management affordances: rename,
 *    reorder (move left/right), delete;
 *  - "Reset to default" (rendered only when custom views exist) deletes
 *    every custom view of the surface — the default view is
 *    derived-not-stored, so emptying the table IS the factory state (the
 *    schema cannot express a default).
 *
 * The bar renders even while the views load (the Default tab + "+" are
 * usable immediately) and on an empty collection (the create affordance
 * must not vanish behind row count).
 */

import { useState, type ReactNode } from "react";

import type { QueryAst } from "@notees/query";

import type { HostedSectionKey, SectionView } from "@/core/workspace-client/index.js";

import {
  createSectionView,
  deleteSectionView,
  renameSectionView,
  reorderSectionViews,
  useSectionViews,
} from "./sectionViews.js";
import { Button, Badge, ConfirmationModal, Modal, Tabs, TextField } from "../../components/ui/kit/index.js";
import { Icon } from "../../ui/Icon.js";
import type { AnyClient } from "./types.js";
import "./NodeCollectionTabs.css";

/** The permanent default tab's value (never a view id). */
export const SECTION_DEFAULT_TAB = "default";

/** The auto label for a new tab: the first free "View N". */
export function autoViewName(existing: readonly SectionView[]): string {
  const names = new Set(existing.map((view) => view.name));
  let n = 1;
  while (names.has(`View ${n}`)) n += 1;
  return `View ${n}`;
}

export interface NodeCollectionTabsProps {
  client: AnyClient;
  nodeId: string;
  /** The hosted surface — a system-section key or "" for a node's main query. */
  sectionKey: HostedSectionKey | "";
  /** The selected tab (SECTION_DEFAULT_TAB or a view id) — owned by the host. */
  selected: string;
  onSelect: (tab: string) => void;
  /**
   * The AST a new tab starts from — the host's current draft, falling back
   * to the factory AST when the draft is empty.
   */
  createAst: () => QueryAst;
  /**
   * The resolved row count of the SELECTED tab — rides its tab name as a
   * small badge (null/undefined renders none).
   */
  activeCount?: number | null;
  /**
   * The DEFAULT tab's label — the host names it like its system section
   * ("Backlinks", "Unlinked mentions"); absent = "Default".
   */
  defaultTabLabel?: string | undefined;
  /**
   * The host section's chrome riding the bar's far right (the bar's quick
   * search + structured toggle, the view switcher) — one row with the tabs.
   */
  trailing?: ReactNode;
}

export function NodeCollectionTabs({ client, nodeId, sectionKey, selected, onSelect, createAst, activeCount, defaultTabLabel, trailing }: NodeCollectionTabsProps) {
  const { views, lastWriteError } = useSectionViews(client, nodeId, sectionKey);
  const [renaming, setRenaming] = useState<SectionView | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SectionView | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const selectedView = views.find((view) => view.id === selected);
  const selectedIndex = selectedView === undefined ? -1 : views.indexOf(selectedView);

  /** "+": create the tab immediately, no modal. */
  const addTab = async (): Promise<void> => {
    const view = await createSectionView(client, nodeId, sectionKey, {
      name: autoViewName(views),
      queryAst: createAst(),
    });
    if (view !== null) onSelect(view.id);
  };

  const move = async (view: SectionView, delta: -1 | 1) => {
    const from = views.indexOf(view);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= views.length) return;
    const ordered = views.map((entry) => entry.id);
    [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
    await reorderSectionViews(client, nodeId, sectionKey, ordered);
  };

  const openRename = (view: SectionView) => {
    setRenaming(view);
    setRenameValue(view.name);
    setRenameError(null);
  };

  const submitRename = async () => {
    if (renaming === null) return;
    const trimmed = renameValue.trim();
    if (trimmed === "") {
      setRenameError("Name the view before saving it.");
      return;
    }
    const ok = await renameSectionView(client, nodeId, sectionKey, renaming.id, trimmed);
    if (ok) {
      setRenaming(null);
    } else {
      setRenameError("Rename failed — the name may already exist or the server is unreachable.");
    }
  };

  const confirmResetAction = async () => {
    await Promise.all(views.map((view) => deleteSectionView(client, nodeId, sectionKey, view.id)));
    setConfirmReset(false);
    onSelect(SECTION_DEFAULT_TAB);
  };

  return (
    <div className="nt-node-collection-tabs">
      <div className="nt-node-collection-tabs__bar">
        <Tabs className="nt-node-collection-tabs__tabs" value={selected} onChange={onSelect}>
          <Tabs.List>
            <Tabs.Tab value={SECTION_DEFAULT_TAB}>
              {defaultTabLabel ?? "Default"}
              {selected === SECTION_DEFAULT_TAB && activeCount != null && (
                <span className="nt-node-collection-tabs__tab-count" aria-hidden="true">
                  <Badge size="xs">{activeCount}</Badge>
                </span>
              )}
            </Tabs.Tab>
            {views.map((view) => (
              <Tabs.Tab key={view.id} value={view.id}>
                {view.name}
                {selected === view.id && activeCount != null && (
                  <span className="nt-node-collection-tabs__tab-count" aria-hidden="true">
                    <Badge size="xs">{activeCount}</Badge>
                  </span>
                )}
              </Tabs.Tab>
            ))}
            {/* The "+" rides the tablist's END — the last item beside the
                tabs, not with the right-hand
                chrome. It creates the tab outright. */}
            <Tabs.AddButton
              aria-label="Add custom view"
              onClick={() => void addTab()}
            />
          </Tabs.List>
        </Tabs>
        {/* Reset to default: only when there are custom views to reset —
            the factory state needs no reset affordance. */}
        {views.length > 0 && (
          <button
            type="button"
            className="nt-node-collection-tabs__reset"
            title="Remove all custom views from this section"
            onClick={() => setConfirmReset(true)}
          >
            Reset to default
          </button>
        )}
        {trailing}
      </div>

      {selectedView !== undefined && (
        <div className="nt-node-collection-tabs__manage">
          <span className="nt-node-collection-tabs__manage-name">{selectedView.name}</span>
          <Button
            variant="ghost"
            size="xs"
            icon="mdi-pencil-outline"
            aria-label={`Rename ${selectedView.name}`}
            title="Rename"
            onClick={() => openRename(selectedView)}
          />
          <Button
            variant="ghost"
            size="xs"
            icon="mdi-arrow-left"
            aria-label={`Move ${selectedView.name} left`}
            title="Move left"
            disabled={selectedIndex <= 0}
            onClick={() => void move(selectedView, -1)}
          />
          <Button
            variant="ghost"
            size="xs"
            icon="mdi-arrow-right"
            aria-label={`Move ${selectedView.name} right`}
            title="Move right"
            disabled={selectedIndex < 0 || selectedIndex >= views.length - 1}
            onClick={() => void move(selectedView, 1)}
          />
          <Button
            variant="danger"
            size="xs"
            icon="mdi-close"
            aria-label={`Delete ${selectedView.name}`}
            title="Delete view"
            onClick={() => setConfirmDelete(selectedView)}
          />
        </div>
      )}

      {lastWriteError !== null && (
        <p className="nt-error" role="alert">
          {lastWriteError}
        </p>
      )}

      <Modal
        isOpen={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename view"
        size="sm"
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button type="button" variant="primary" onClick={() => void submitRename()}>
              Rename
            </Button>
          </>
        }
      >
        <TextField
          label="View name"
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
        />
        {renameError !== null && (
          <p className="nt-error" role="alert">
            {renameError}
          </p>
        )}
      </Modal>

      <ConfirmationModal
        isOpen={confirmDelete !== null}
        title={`Delete ${confirmDelete?.name ?? "view"}?`}
        message="The view's tab and filter are removed. The default view is not affected."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (confirmDelete !== null) {
            await deleteSectionView(client, nodeId, sectionKey, confirmDelete.id);
            setConfirmDelete(null);
            onSelect(SECTION_DEFAULT_TAB);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />

      <ConfirmationModal
        isOpen={confirmReset}
        title="Reset to default?"
        message="Every custom view on this section is removed. The default view renders the section's factory behavior."
        confirmLabel="Reset to default"
        variant="danger"
        onConfirm={() => confirmResetAction()}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
