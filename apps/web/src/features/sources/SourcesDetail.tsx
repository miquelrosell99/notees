/**
 * SourcesDetail — the Sources hub's right pane: the selected source's
 * type-aware detail editor. Nothing here is bespoke chrome beyond
 * composition:
 *
 *  - The TYPE CHIP rides the same primary-type pick the table rows carry
 *    (sourceTypeKey) — icon + the class's live title.
 *  - The TITLE edits inline, click-to-edit like the page-header description
 *    (Enter/blur commits, Esc cancels), writing through the content path —
 *    title-is-content: one `object.update` with a single text run, the same
 *    write shape the date-chain heal and the text property rows use. Source
 *    titles are authored text-only (the add-source create writes one run);
 *    a rich-token title would flatten exactly the way the content-stringify
 *    boundary always flattens (SCHEMA.md).
 *  - The FIELD SET is the existing metadata properties panel, verbatim:
 *    the shared PropertiesTable over the effective read — extends-aware, so
 *    a journal article shows its own bound-but-empty volume/issue/pages
 *    rows (never a docketNumber — not bound, never eligible) beside the
 *    family-base rows. The type-aware field set IS the binding fix: the
 *    pane mounts no field list of its own.
 *  - OPEN navigates the node in the page view (the App's openPage seam);
 *    DELETE asks in the reusable ConfirmationModal (danger, naming the
 *    display name — never a raw uuid) and trashes through deleteObject,
 *    the node-menu's confirm pattern.
 *  - FETCH METADATA (the action row, beside Open) resolves the source's
 *    DOI/PMID through the metadata resolver and fills the EMPTY fields
 *    only (Notees-wins — the fetchMetadataFill plan/apply pair), the
 *    on-node counterpart of the Add Source dialog's create-time fetch and
 *    the CLI's `notees source fetch-metadata`. The Attachments-row Fetch
 *    button's gate: resolver setting on + coordinates registered; a source
 *    without a DOI/PMID renders the button disabled with the why in its
 *    title. Outcome/error reads as one note line under the row.
 *
 * Live by subscription (the facets/table idiom): an edit here re-reads
 * through the client's notify. Nothing selected (or the node is gone)
 * renders the honest empty state.
 */

import { useState } from "react";

import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  deriveDisplayName,
  type SystemClassName,
} from "@notees/domain";

import type { AnyClient } from "../../ui/app/clients.js";
import { Icon } from "../../ui/Icon.js";
import { titleOf } from "../../ui/dateDisplay.js";
import {
  Button,
  ConfirmationModal,
  EmptyState,
  TextField,
  useClientVersion,
} from "../../components/ui/kit/index.js";
import { NodeViewSection } from "../page-sections/NodeViewSection.js";
import { PropertiesTable, metadataRowCount } from "../metadata/index.js";
import { readSourceSettings } from "../modals/quickCreate.js";
import { resolveCoordinates } from "./resolveCoordinates.js";
import { resolveSourceInput } from "./resolver.js";
import {
  applyFetchMetadataFill,
  planFetchMetadataFill,
  planFillNames,
  planIsEmpty,
  sourceIdentifierOf,
} from "./fetchMetadataFill.js";
import { sourceTypeKey } from "./sourcesQuery.js";
import "./SourcesDetail.css";

export function SourcesDetail({
  client,
  selectedId,
  onOpenNode,
  onDeleted,
}: {
  client?: AnyClient | undefined;
  /** The hub-owned single selection (null = the honest empty state). */
  selectedId?: string | null | undefined;
  /** The App's page-view open seam (the Open affordance + mention opens). */
  onOpenNode?: ((nodeId: string) => void) | undefined;
  /** Fired after a delete lands — the hub clears its selection. */
  onDeleted?: ((nodeId: string) => void) | undefined;
}) {
  // Live by subscription: a property write here (or anywhere) re-reads.
  useClientVersion(client);
  /** The title's inline editor swap. */
  const [titleEditing, setTitleEditing] = useState(false);
  /** The latched delete-confirm target (the node-menu latch idiom). */
  const [pendingDelete, setPendingDelete] = useState<{ id: string; label: string } | null>(null);
  /** The Fetch-metadata resolver round: busy latch + outcome/error note. */
  const [fetchingMetadata, setFetchingMetadata] = useState(false);
  const [fetchNote, setFetchNote] = useState<{ kind: "outcome" | "error"; text: string } | null>(null);

  const node =
    client !== undefined && selectedId !== undefined && selectedId !== null
      ? client.getNode(selectedId)
      : undefined;
  if (client === undefined || node === undefined) {
    return (
      <EmptyState
        icon={<Icon path="mdi-text-box-search-outline" size={2} />}
        title="Select a source"
        description="Pick a source in the list to see its details."
      />
    );
  }

  const title = deriveDisplayName(node);
  const typeKey: SystemClassName = sourceTypeKey(client, node);
  const typeClassId = SYSTEM_CLASS_UUIDS[typeKey];
  const typeLabel =
    titleOf(client, typeClassId) ?? SYSTEM_CLASS_DISPLAY_NAMES[typeKey];
  const typeIcon = client.effectiveClassIcons().get(typeClassId) ?? null;

  const commitTitle = (value: string): void => {
    // Skip the no-op write when the flattened text is unchanged.
    if (value !== title) {
      void client.updateObject(node.id, { contentAst: [{ type: "text", text: value }] });
    }
    setTitleEditing(false);
  };

  // The Fetch-metadata surface gate: the resolver setting on, coordinates
  // registered (online), and a resolvable identifier on the node — the
  // Attachments-row Fetch gate's sibling (AssetPropertyRow).
  const identifier = sourceIdentifierOf(client, node.id);
  const fetchMetadataEligible =
    readSourceSettings(client).resolverEnabled && resolveCoordinates() !== null;

  const schemaNameOf = (schemaId: string): string =>
    client.listPropertySchemas().find((schema) => schema.id === schemaId)?.name ?? schemaId;

  const fetchMetadata = async (): Promise<void> => {
    if (fetchingMetadata) return;
    const coords = resolveCoordinates();
    if (coords === null || identifier === null) return;
    setFetchingMetadata(true);
    setFetchNote(null);
    try {
      const record = await resolveSourceInput(coords.serverUrl, coords.credential, identifier.value, {
        getAdsApiToken: async () => (await client.getPrefs())?.adsApiToken ?? "",
      });
      const plan = planFetchMetadataFill(client, node, record);
      if (planIsEmpty(plan)) {
        setFetchNote({ kind: "outcome", text: "Everything the resolver knows is already filled." });
        return;
      }
      await applyFetchMetadataFill(client, node.id, plan);
      const names = planFillNames(plan, schemaNameOf);
      setFetchNote({ kind: "outcome", text: `Filled ${names.length} (${names.join(", ")}).` });
    } catch (err) {
      setFetchNote({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setFetchingMetadata(false);
    }
  };

  return (
    <div className="nt-sources-detail nt-main-frame__panel-content">
      {/* The whole title is the click-to-edit target (the page-header idiom). */}
      {titleEditing ? (
        <TextField
          autoFocus
          size="md"
          className="nt-sources-detail__title-input"
          defaultValue={title}
          aria-label="Source title"
          onKeyDown={(event) => {
            if (event.key === "Enter") commitTitle(event.currentTarget.value);
            if (event.key === "Escape") setTitleEditing(false);
          }}
          onBlur={(event) => commitTitle(event.currentTarget.value)}
        />
      ) : (
        <h2
          className="nt-sources-detail__title"
          title="Title (click: edit)"
          onClick={() => setTitleEditing(true)}
        >
          {title}
        </h2>
      )}

      <div className="nt-sources-detail__row">
        <span className="nt-sources-detail__type">
          {typeIcon !== null && <Icon path={typeIcon} size={0.8} />}
          <span>{typeLabel}</span>
        </span>
        <span className="nt-sources-detail__spacer" />
        {fetchMetadataEligible && (
          <Button
            variant="ghost"
            size="sm"
            icon="mdi-cloud-sync-outline"
            aria-label="Fetch metadata"
            title={
              identifier === null
                ? "Fetch metadata — set a DOI or PMID on this source first"
                : `Fetch metadata — resolve ${identifier.kind === "doi" ? "the DOI" : "the PMID"} and fill the empty fields`
            }
            loading={fetchingMetadata}
            disabled={fetchingMetadata || identifier === null}
            onClick={() => void fetchMetadata()}
          />
        )}
        {onOpenNode !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            icon="mdi-open-in-app"
            aria-label="Open page"
            title="Open page"
            onClick={() => onOpenNode(node.id)}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          icon="mdi-delete-outline"
          aria-label="Delete source"
          title="Delete source"
          onClick={() => setPendingDelete({ id: node.id, label: title })}
        />
      </div>
      {fetchNote !== null && (
        <p
          role={fetchNote.kind === "error" ? "alert" : undefined}
          className={
            fetchNote.kind === "error"
              ? "nt-sources-detail__fetch-note nt-sources-detail__fetch-note--error"
              : "nt-sources-detail__fetch-note"
          }
        >
          {fetchNote.text}
        </p>
      )}

      {/* The type-aware field set: the shared metadata panel over the
          effective read (extends-aware — the picked type's own bindings
          ride above the family base's; bound-but-empty rows included). */}
      <NodeViewSection
        title="Metadata"
        icon={<Icon path="mdi-format-list-bulleted-square" size={0.9} />}
        count={metadataRowCount(client, node.id)}
        defaultExpanded
      >
        <PropertiesTable client={client} nodeId={node.id} onOpenPage={onOpenNode} />
      </NodeViewSection>

      <ConfirmationModal
        isOpen={pendingDelete !== null}
        title={pendingDelete === null ? "" : `Delete ${pendingDelete.label}?`}
        message={
          pendingDelete === null
            ? ""
            : `This will delete "${pendingDelete.label}" and everything it contains.`
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={async () => {
          if (pendingDelete === null) return;
          const target = pendingDelete;
          await client.deleteObject(target.id);
          setPendingDelete(null);
          onDeleted?.(target.id);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
