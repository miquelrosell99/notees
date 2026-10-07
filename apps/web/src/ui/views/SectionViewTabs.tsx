/**
 * SectionViewTabs — the hosted-views chrome (the custom-tabs tab bar riding
 * WITH a hosted NodeCollection):
 *
 *  - the DEFAULT tab renders the section's factory behavior — permanent,
 *    first, never closable, never replaced;
 *  - custom tabs are additive, ordered by sequence, each refining the base
 *    row set with its stored query_ast (sectionViewResolve);
 *  - "+" opens the FilterBuilderModal (the one-grammar AST producer) — a
 *    transient filter persists VERBATIM as the new view's query_ast. In this
 *    host the modal's "Run" also persists (a tab IS the run target here) —
 *    with an auto label when the name field is empty;
 *  - the active custom tab carries its management affordances: rename,
 *    reorder (move left/right), delete;
 *  - "Reset to default" is always available: it deletes every custom view
 *    of the section — the default view is derived-not-stored, so emptying
 *    the table IS the factory state (the schema cannot express a default).
 *
 * The bar renders even while the views load (the Default tab + "+" are
 * usable immediately) and on an empty collection (the create affordance
 * must not vanish behind row count).
 */

import { useState } from "react";

import type { QueryAst } from "@notees/query";

import type { HostedSectionKey, SectionView } from "@/core/workspace-client.js";

import { FilterBuilderModal } from "../components/FilterBuilderModal.js";
import {
  createSectionView,
  deleteSectionView,
  renameSectionView,
  reorderSectionViews,
  useSectionViews,
} from "../components/sectionViews.js";
import { Button, ConfirmationModal, Modal, Tabs, TextField } from "../components/ui/index.js";
import { Icon } from "../Icon.js";
import type { AnyClient } from "./types.js";
import "./SectionViewTabs.css";

/** The permanent default tab's value (never a view id). */
export const SECTION_DEFAULT_TAB = "default";

/** The auto label for the modal's Run outcome: the first free "View N". */
export function autoViewName(existing: readonly SectionView[]): string {
  const names = new Set(existing.map((view) => view.name));
  let n = 1;
  while (names.has(`View ${n}`)) n += 1;
  return `View ${n}`;
}

export interface SectionViewTabsProps {
  client: AnyClient;
  nodeId: string;
  sectionKey: HostedSectionKey;
  /** The selected tab (SECTION_DEFAULT_TAB or a view id) — owned by the host. */
  selected: string;
  onSelect: (tab: string) => void;
}

export function SectionViewTabs({ client, nodeId, sectionKey, selected, onSelect }: SectionViewTabsProps) {
  const { views, lastWriteError } = useSectionViews(client, nodeId, sectionKey);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [renaming, setRenaming] = useState<SectionView | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SectionView | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const selectedView = views.find((view) => view.id === selected);
  const selectedIndex = selectedView === undefined ? -1 : views.indexOf(selectedView);

  const persist = async (ast: QueryAst, name: string): Promise<void> => {
    const view = await createSectionView(client, nodeId, sectionKey, { name, queryAst: ast });
    if (view !== null) onSelect(view.id);
  };

  const handleSaveAsView = (ast: QueryAst, name: string) => persist(ast, name);

  // In this host "Run" also persists: the tab bar is the run target. The
  // modal's name field is not handed to onRun, so an auto label.
  const handleRun = (ast: QueryAst) => {
    void persist(ast, autoViewName(views));
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
    onSelect(SECTION_DEFAULT_TAB);
  };

  return (
    <div className="nt-section-views">
      <div className="nt-section-views__bar">
        <Tabs className="nt-section-views__tabs" value={selected} onChange={onSelect}>
          <Tabs.List>
            <Tabs.Tab value={SECTION_DEFAULT_TAB}>Default</Tabs.Tab>
            {views.map((view) => (
              <Tabs.Tab key={view.id} value={view.id}>
                {view.name}
              </Tabs.Tab>
            ))}
            <Tabs.AddButton
              aria-label="Add custom view"
              onClick={() => setBuilderOpen(true)}
            />
          </Tabs.List>
        </Tabs>
        {/* Reset to default: always available, disabled when there is
            nothing to reset — the factory state needs no confirmation. */}
        <button
          type="button"
          className="nt-section-views__reset"
          disabled={views.length === 0}
          title="Remove all custom views from this section"
          onClick={() => setConfirmReset(true)}
        >
          Reset to default
        </button>
      </div>

      {selectedView !== undefined && (
        <div className="nt-section-views__manage">
          <span className="nt-section-views__manage-name">{selectedView.name}</span>
          <button
            type="button"
            className="nt-section-views__action"
            aria-label={`Rename ${selectedView.name}`}
            title="Rename"
            onClick={() => openRename(selectedView)}
          >
            <Icon path="mdi-pencil-outline" size={0.8} />
          </button>
          <button
            type="button"
            className="nt-section-views__action"
            aria-label={`Move ${selectedView.name} left`}
            title="Move left"
            disabled={selectedIndex <= 0}
            onClick={() => void move(selectedView, -1)}
          >
            <Icon path="mdi-arrow-left" size={0.8} />
          </button>
          <button
            type="button"
            className="nt-section-views__action"
            aria-label={`Move ${selectedView.name} right`}
            title="Move right"
            disabled={selectedIndex < 0 || selectedIndex >= views.length - 1}
            onClick={() => void move(selectedView, 1)}
          >
            <Icon path="mdi-arrow-right" size={0.8} />
          </button>
          <button
            type="button"
            className="nt-section-views__action nt-section-views__action--danger"
            aria-label={`Delete ${selectedView.name}`}
            title="Delete view"
            onClick={() => setConfirmDelete(selectedView)}
          >
            <Icon path="mdi-close" size={0.8} />
          </button>
        </div>
      )}

      {lastWriteError !== null && (
        <p className="nt-error" role="alert">
          {lastWriteError}
        </p>
      )}

      <FilterBuilderModal
        client={client}
        isOpen={builderOpen}
        onClose={() => setBuilderOpen(false)}
        scopeAnchor={{ rootId: nodeId, rootIsPage: true }}
        onRun={handleRun}
        onSaveAsView={handleSaveAsView}
      />

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
