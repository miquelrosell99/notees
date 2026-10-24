/**
 * AppModals — the shell's floating-command layer: the Ctrl/Cmd+K command
 * palette and the modals/popups it and the other surfaces open (quick
 * add, class create, merge, property view), the S1 property-create host
 * (the /property slash command, Ctrl/Cmd+Alt+P, the verb create-and-bind),
 * plus the mobile quick-create FAB and the presentation deck. Pure
 * composition: every behavior arrives via props from App.
 */

import type { Dispatch, SetStateAction } from "react";

import { WorkspaceClient } from "@/core/workspace-client/index.js";
import type { UndoUiState } from "@/core/undo-journal.js";
import type { AnyClient } from "./clients.js";
import type { StoreMode } from "./storeMode.js";
import { CommandPalette } from "../../features/command-palette/CommandPalette.js";
import { QuickAddModal } from "../../features/modals/QuickAddModal.js";
import { ClassCreateModal } from "../../features/modals/ClassCreateModal.js";
import { MergeNodesModal } from "../../features/modals/MergeNodesModal.js";
import { PropertyView } from "../../features/metadata/PropertyView.js";
import { PropertyCreateHost } from "../../features/metadata/PropertyCreateHost.js";
import { QuickCreateFab } from "../../features/block-editor/QuickCreateFab.js";
import { AddSourceHost, requestAddSource } from "../../features/sources/AddSourceHost.js";
import { DeckView } from "../presentation/DeckView.js";

export interface AppModalsProps {
  client: AnyClient;
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  openPage: (nodeId: string) => void;
  handleNewPage: (title?: string) => Promise<void>;
  classCreateOpen: boolean;
  setClassCreateOpen: Dispatch<SetStateAction<boolean>>;
  propertyViewFor: string | null;
  setPropertyViewFor: Dispatch<SetStateAction<string | null>>;
  selectedPageId: string | null;
  storeMode: StoreMode;
  mergeOpen: boolean;
  setMergeOpen: Dispatch<SetStateAction<boolean>>;
  condensedActive: boolean;
  setCondensedPref: (value: boolean) => void;
  openSearchPage: (query?: string) => void;
  handleSignOut: () => Promise<void>;
  undoUi: UndoUiState;
  runUndo: () => void;
  runRedo: () => void;
  pagesVersion: number;
  quickAddOpen: boolean;
  setQuickAddOpen: Dispatch<SetStateAction<boolean>>;
  presentingId: string | null;
  setPresentingId: Dispatch<SetStateAction<string | null>>;
  /** The sync server coordinates for the add-source host (null = offline). */
  addSourceServerUrl: string | null;
  addSourceCredential: string;
}

export function AppModals(props: AppModalsProps) {
  const {
    client,
    paletteOpen,
    setPaletteOpen,
    openPage,
    handleNewPage,
    classCreateOpen,
    setClassCreateOpen,
    propertyViewFor,
    setPropertyViewFor,
    selectedPageId,
    storeMode,
    mergeOpen,
    setMergeOpen,
    condensedActive,
    setCondensedPref,
    openSearchPage,
    handleSignOut,
    undoUi,
    runUndo,
    runRedo,
    pagesVersion,
    quickAddOpen,
    setQuickAddOpen,
    presentingId,
    setPresentingId,
    addSourceServerUrl,
    addSourceCredential,
  } = props;
  return (
    <>
      <CommandPalette
        client={client}
        open={paletteOpen}
        onRequestOpen={() => setPaletteOpen(true)}
        onClose={() => setPaletteOpen(false)}
        onOpenNode={openPage}
        onNewPage={(title) => void handleNewPage(title)}
        onOpenClassCreate={() => setClassCreateOpen(true)}
        onOpenAddSource={
          addSourceServerUrl !== null ? () => requestAddSource({}) : undefined
        }
        onOpenProperty={(schemaId) => setPropertyViewFor(schemaId)}
        currentNodeId={selectedPageId ?? undefined}
        onOpenMerge={storeMode === "in-process" ? () => setMergeOpen(true) : undefined}
        condensedActive={condensedActive}
        onToggleCondensed={
          selectedPageId !== null ? () => setCondensedPref(!condensedActive) : undefined
        }
        onOpenSearch={(query) => openSearchPage(query)}
        onSignOut={() => void handleSignOut()}
        undoState={undoUi}
        onUndo={runUndo}
        onRedo={runRedo}
        cacheVersion={pagesVersion}
      />
      {quickAddOpen && (
        <QuickAddModal isOpen={quickAddOpen} onClose={() => setQuickAddOpen(false)} client={client} />
      )}
      {classCreateOpen && (
        <ClassCreateModal
          isOpen
          client={client}
          onClose={() => setClassCreateOpen(false)}
          onCreated={(id) => openPage(id)}
        />
      )}
      {mergeOpen && selectedPageId !== null && client instanceof WorkspaceClient && (
        <MergeNodesModal
          isOpen
          client={client}
          sourceId={selectedPageId}
          onClose={() => setMergeOpen(false)}
          onMerged={(targetId) => {
            setMergeOpen(false);
            openPage(targetId);
          }}
        />
      )}
      {propertyViewFor !== null && (
        <PropertyView
          client={client}
          propertySchemaId={propertyViewFor}
          onClose={() => setPropertyViewFor(null)}
          onOpenPage={(id) => {
            setPropertyViewFor(null);
            openPage(id);
          }}
        />
      )}
      {/* The mobile quick-create FAB: hosts its own
          QuickAddModal; CSS surfaces the button only at narrow widths. */}
      <QuickCreateFab client={client} />
      {/* The S1 property-creation modal's app-level host: the slash
          /property command, the Ctrl/Cmd+Alt+P chord, and the
          VerbPopover create-and-bind request the modal through the
          module-level queue. */}
      <PropertyCreateHost client={client} />
      {/* The add-source dialog's app-level host: the palette row, the
          Sources settings button, and the picker's paste-URL row request
          the dialog through the module-level queue (offline: no server
          coordinates, the host hides itself). */}
      <AddSourceHost
        client={client}
        serverUrl={addSourceServerUrl}
        credential={addSourceCredential}
        onCreated={openPage}
        onOpenNode={openPage}
      />
      {presentingId !== null && (
        <DeckView
          client={client}
          pageId={presentingId}
          onOpenNode={openPage}
          onClose={() => setPresentingId(null)}
        />
      )}
    </>
  );
}
