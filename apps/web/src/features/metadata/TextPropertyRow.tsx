/**
 * TextPropertyRow — one text property rendered as a BLOCKS LIST
 *: a single property row whose values are the carrier blocks
 * themselves (editable, children and all) — never repeated "label: value"
 * entries per value.
 *
 * The carriers render through the shared collection dispatcher: a locked
 * outline NodeCollection (no view switcher; `showBreadcrumbs` OFF — a trail
 * above a value block would name the very node the cell already renders
 * on), one root item per carrier, each
 * root row hosted in its own per-carrier outliner context — the same editing
 * context the standalone subtree renderer used to host, so bullet navigation,
 * collapse, and the keyboard gestures behave exactly as they did there.
 * The value rows wear ONE chrome — the list-projection idiom
 * (`hideBacklinkCount`/`hideProperties`/`hideTags`, the hubs' precedent):
 * per-row backlink/property/tag chrome is data-dependent noise on a value,
 * so every root reads the same bullet-less block row (the root bullet hides
 * in MetadataSection.css) and only nested children keep theirs.
 *
 * Enter semantics ride the CarrierEnterContext (see textCarrier.ts):
 *  - multi-value: Enter on a value creates a SIBLING block registered as the
 *    next property value;
 *  - single-value: Enter nests a CHILD block under the carrier — the value
 *    is one block whose children are its lines.
 *
 * Values that don't resolve to a carrier block keep two fallback
 * cells: a DEAD reference (a uuid that no longer resolves) renders EMPTY and
 * re-authors a fresh carrier through the minimal text input; a legacy
 * SCALAR STRING (the resolver/create flow's shape for freshly authored
 * values, pre-carrier text values) renders AS A BLOCK ROW — the same
 * bullet + content shape the carrier rows ride, so every text value reads
 * as a block (single-value rows included) — bare URLs linkify through the
 * markdownLinks grammar; the first edit mints a carrier block carrying the
 * string, wiring the value to it and opening the block editor (the
 * established create-carrier pattern, no new op), from then on the value
 * IS a block: children render indented under it. The scalar row's
 * RIGHT-CLICK mints WITHOUT the editor hand-off and opens the node context
 * menu ON the minted carrier (the scalar isn't a node yet — the menu
 * gesture materializes it first, the ghost-realize precedent); carrier
 * rows render BlockRow, whose own grip menu covers them. A bound-but-empty row
 * renders the platform GHOST ROW (ui/GhostRow — the same muted "+ Add
 * block" affordance the outliner trails; the 2026-11-02 ruling: the ghost
 * is the sole add affordance everywhere, never a field) — the realize
 * click mints the first carrier and opens the block editor.
 *
 * Auto-unset: an authored value whose carrier has no
 * content and no child blocks is unset automatically — a dead ref whose
 * target node is gone counts as contentless (one that exists but no longer
 * renders inline keeps the recovery cell) — so clearing a text property
 * returns the slot to its empty state instead of lingering as an empty block
 * or a dead cell. The pass runs on every store-synced render and when focus
 * leaves the row; a carrier is skipped while focus is inside the row (an
 * Add/Enter just minted an empty value the user may be about to type into)
 * — and unsetting trashes the carrier — "Unset deletes the carrier".
 *
 * Assigned-empty rows: the row renders the same ghost row as a
 * bound-but-empty row; the realize click mints the carrier block and
 * authors the {nodeId} value.
 *
 * The trailing realize ghost: a multi-value row with values trails the
 * platform ghost (the empty-state cell's twin — the ghost is the sole add
 * affordance, never an AddPill): one click mints an empty carrier at the
 * next idx and opens the block editor on it (the fresh-carrier effect).
 * Single-value rows trail none — their empty state owns the cell's ghost.
 *
 * A default-sourced row whose value is the SCALAR EMPTY STRING (the citekey
 * seed's `defaultValue: ""`) renders the SAME ghost row — an empty default
 * is an empty field, not a value; the realize click still mints the
 * carrier (semantics unchanged), and the citekey regenerate affordance
 * rides the row's right edge as before.
 *
 * Citekey regeneration: the citekey row of a source-LINEAGE node (the
 * class-lineage keying quick-create uses, never a hardcoded node set)
 * carries a trailing regenerate affordance INSIDE the field at its right
 * edge (the searchbox clear-x pattern): the workspace pattern rendered from
 * the node's current metadata, collision-suffixed against the sibling
 * sources, written through the row's `property.set` path (no new op,
 * undo-journal eligible). Empty metadata disables the button.
 *
 * Block-to-property drop (S5): the row registers
 * as a drop target of the ONE workspace drag session — dragging a
 * same-owner body block onto the row makes the block the value's carrier
 * (single empty slot: one property.set; occupied single: never an
 * overwrite; multi: an append with a fresh PG5 elementId). The affordance
 * (empty-slot ring / drop-over state-layer / no-drop cursor) renders off
 * the shared decision matrix while a block drag is live; the plan re-runs
 * at release time in the drag host (ui/property-drop.ts).
 */

import { useEffect, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../ui/Icon.js";

import { plainTextExcerpt, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { EffectiveProperty } from "@/core/workspace-client/index.js";

import { useClientVersion } from "../../components/ui/kit/useClientVersion.js";
import { NodeCollection, type NodeCollectionItem } from "../collection/index.js";
import type { AnyClient } from "../collection/types.js";
import { carrierStateOf } from "./carrierState.js";
import { GhostRow } from "../../ui/GhostRow.js";
import { NodeContextMenu } from "../node-menu/NodeContextMenu.js";
import { isCitationFamilyClass } from "../modals/quickCreate.js";
import { citekeyRegenerationFor } from "../sources/citekeyRegenerate.js";
import {
  citekeyIsPinned,
  citekeyPinMetadata,
  CITEKEY_PINNED_METADATA_KEY,
} from "../sources/citekeyTrack.js";
import { citekeyTextOf } from "../sources/citekeyValue.js";
import { InlineTokens } from "../../ui/InlineTokens.js";
import { OutlinerContext, useOutlinerValue } from "../../ui/outliner-context.js";
import { CarrierEnterContext, type CarrierInfo } from "../../ui/textCarrier.js";
import { DragSourcesContext } from "../../ui/block-dnd.js";
import { useWorkspaceDndPropertyDrop } from "../../ui/useWorkspaceDnd.js";
import { propertyDropVerdict } from "../../ui/property-drop.js";

/** Cycle-protection depth cap, mirroring the client's getBlockTree default. */
const CARRIER_TREE_DEPTH_CAP = 64;

/** The carrier's editable subtree (recursive, depth-capped). */
function carrierSubtreeOf(
  client: AnyClient,
  nodeId: string,
  remaining = CARRIER_TREE_DEPTH_CAP,
): NodeCollectionItem[] {
  if (remaining <= 0) return [];
  return client.getChildren(nodeId).map((child) => ({
    node: child,
    children: carrierSubtreeOf(client, child.id, remaining - 1),
  }));
}

/**
 * The (owner, schema) carrier resolution behind the locked collection: every
 * authored value that resolves to a live carrier block becomes one root item
 * — the carrier plus its editable subtree. Multi-value schemas can carry
 * several; each renders as a root item. Dead refs and legacy scalar strings
 * are NOT items — they stay the fallback input cells at the call site.
 */
function carrierItemsOf(client: AnyClient, rows: EffectiveProperty[]): NodeCollectionItem[] {
  const items: NodeCollectionItem[] = [];
  for (const row of rows) {
    const state = carrierStateOf(client, row.value);
    if (state.kind !== "carrier") continue;
    const node = client.getNode(state.id);
    if (node === undefined) continue;
    items.push({ node, children: carrierSubtreeOf(client, state.id) });
  }
  return items;
}

/**
 * One carrier root row's editing context: the per-carrier outliner value the
 * standalone subtree renderer hosted (carrier-scoped positions and collapse,
 * bullet click opens the node — and Shift+click peeks it in the right rail,
 * the page body's bullet gesture). The collection's
 * default row renders inside the provider, so BlockRow resolves THIS
 * context instead of the enclosing page's.
 */
function CarrierRowHost({
  client,
  item,
  onOpenPage,
  onOpenInSidebar,
  children,
}: {
  client: AnyClient;
  item: NodeCollectionItem;
  onOpenPage?: ((pageId: string) => void) | undefined;
  onOpenInSidebar?: ((pageId: string) => void) | undefined;
  children: ReactNode;
}) {
  const outliner = useOutlinerValue(client, item.node.id, {
    openNode: (id) => onOpenPage?.(id),
    openInSidebar: (id) => onOpenInSidebar?.(id),
  });
  return <OutlinerContext.Provider value={outliner}>{children}</OutlinerContext.Provider>;
}

export function TextPropertyRow({
  client,
  nodeId,
  propertySchemaId,
  label,
  multi,
  rows,
  onOpenPage,
  onOpenInSidebar,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
  /** Read-only projection: carriers render as read-only rows, scalars as
   *  text — no add affordance, no auto-unset pass. */
  readOnly = false,
  /** Extra li class (the R4 ineligible rendering — " nt-property-ineligible"). */
  rowClassName = "",
  /** The host knows the property is class-supplied even when rows carry no boundBy
   *  (the empty assigned/bound reduction) — the from-class badge rides this. */
  classBound = false,
  /** The property-header icon (effectivePropertyIcon). */
  icon,
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  rows: EffectiveProperty[];
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** The carrier bullet's Shift+click peek. */
  onOpenInSidebar?: ((pageId: string) => void) | undefined;
  bare?: boolean;
  readOnly?: boolean | undefined;
  rowClassName?: string;
  classBound?: boolean;
  icon: string;
}) {
  const ordered = [...rows].sort((a, b) => a.idx - b.idx);
  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const unbound = rows.some((row) => row.source === "authored" && row.boundBy === null);
  const classSourced = rows.some((row) => row.boundBy !== null) || classBound;
  const [addError, setAddError] = useState<string | null>(null);

  // The standalone subtree renderer carried its own subscription per carrier
  // root so the cell stays live even outside a subscribing host; the row
  // keeps that contract with one subscription for all its carriers. The
  // version value feeds the citekey-regeneration memo below.
  const storeVersion = useClientVersion(client);

  /**
   * The citekey regeneration snapshot — ONLY on the citekey row of a
   * source-lineage node (the class-lineage keying quick-create uses, never
   * a hardcoded node set). Recomputed on every store-synced render so the
   * button's disabled state tracks the metadata live.
   */
  const citekeyRegen = useMemo(() => {
    if (readOnly || propertySchemaId !== SYSTEM_PROPERTY_UUIDS.citekey) return null;
    const node = client.getNode(nodeId);
    if (node === undefined) return null;
    if (!node.classIds.some((classId) => isCitationFamilyClass(client, classId))) return null;
    return citekeyRegenerationFor(client, node);
  }, [client, nodeId, propertySchemaId, readOnly, storeVersion]);

  /** The trailing regenerate affordance (the searchbox clear-x pattern —
   *  INSIDE the field at its right edge). Disabled when the metadata
   *  renders empty — nothing to generate from. The write rides the row's
   *  `property.set` path at the cell's own idx. */
  const citekeyRegenButton = (idx: number) =>
    citekeyRegen === null ? null : (
      <button
        type="button"
        className="nt-property-value-field__action"
        aria-label="Regenerate citekey"
        title="Regenerate citekey"
        disabled={citekeyRegen.value === ""}
        onClick={() => void client.setProperty(nodeId, propertySchemaId, citekeyRegen.value, idx)}
      >
        <Icon path="mdi mdi-refresh" size={0.8} />
      </button>
    );

  /**
   * The citekey pin state — ONLY on the citekey row of a source-LINEAGE
   * node (the class-lineage keying quick-create uses). Lives beside the
   * property NAME (not inside a value cell) so it renders for BOTH storage
   * shapes — the scalar string and the manual-edit carrier ride different
   * cells, and the pin must toggle from either. Disabled when no non-empty
   * authored value exists: pinning an empty citekey would ride a scalar ""
   * the auto-unset pass trashes. The toggle re-writes the CURRENT value
   * with the flipped flag (LWW at the row) — value-preserving by
   * construction, one undoable property write.
   */
  const citekeyPin = useMemo(() => {
    if (readOnly || propertySchemaId !== SYSTEM_PROPERTY_UUIDS.citekey) return null;
    const node = client.getNode(nodeId);
    if (node === undefined || node.isClass) return null;
    if (!node.classIds.some((classId) => isCitationFamilyClass(client, classId))) return null;
    const authored = client
      .getEffectiveProperties(nodeId)
      .filter(
        (row) => row.propertySchemaId === propertySchemaId && row.source === "authored",
      );
    const pinned = citekeyIsPinned(authored);
    const current = authored.find((row) => citekeyTextOf(client, row.value) !== "");
    if (current === undefined) return { pinned, disabled: true as const };
    return { pinned, disabled: false as const, value: current.value, idx: current.idx };
  }, [client, nodeId, propertySchemaId, readOnly, storeVersion]);

  const citekeyPinButton =
    citekeyPin === null ? null : (
      <button
        type="button"
        className={
          "nt-property-pin" + (citekeyPin.pinned ? " nt-property-pin--pinned" : "")
        }
        aria-label={citekeyPin.pinned ? "Unpin citekey" : "Pin citekey"}
        title={
          citekeyPin.pinned
            ? "Unpin citekey — auto-update from metadata"
            : "Pin citekey — stop auto-updating from metadata"
        }
        aria-pressed={citekeyPin.pinned}
        disabled={citekeyPin.disabled}
        onClick={() => {
          if (citekeyPin.disabled) return;
          void client.setProperty(
            nodeId,
            propertySchemaId,
            citekeyPin.value,
            citekeyPin.idx,
            citekeyPinMetadata(!citekeyPin.pinned),
          );
        }}
      >
        <Icon path={citekeyPin.pinned ? "mdi mdi-pin" : "mdi mdi-pin-outline"} size={0.8} />
      </button>
    );

  /**
   * A MANUAL citekey edit pins the key (the Zotero/BBT precedent — a
   * hand-typed key is a deliberate choice the auto-track watcher must never
   * overwrite). Every other property rides metadata-free (a metadata-less
   * set REPLACES the stored record — applier LWW — so non-citekey rows must
   * not carry this).
   */
  const manualEditMetadata: Record<string, unknown> | undefined =
    propertySchemaId === SYSTEM_PROPERTY_UUIDS.citekey
      ? { [CITEKEY_PINNED_METADATA_KEY]: true }
      : undefined;

  /** Carrier lookup for the Enter semantics — only THIS row's carriers. */
  const carrierInfo = useMemo(() => {
    const map = new Map<string, CarrierInfo>();
    for (const row of ordered) {
      const state = carrierStateOf(client, row.value);
      if (state.kind === "carrier") {
        map.set(state.id, { ownerId: nodeId, propertySchemaId, multi });
      }
    }
    return map;
  }, [client, ordered, nodeId, propertySchemaId, multi]);

  /** The locked collection's root items — one per live carrier, in value order. */
  const carrierItems = carrierItemsOf(client, ordered);

  const nextIdx = (() => {
    const authored = ordered.filter((row) => row.source === "authored").map((row) => row.idx);
    return authored.length > 0 ? Math.max(...authored) + 1 : 0;
  })();

  const rootRef = useRef<HTMLLIElement | null>(null);
  /**
   * The carrier a scalar-string edit just minted: once it mounts in the
   * locked collection its content is clicked to open the block editor (the
   * TextCell autoEdit precedent — the collection rows take no autoEdit prop,
   * so the DOM click is the opener). Cleared after the click; the effect
   * retries on later renders while the carrier has not mounted yet.
   */
  const [freshCarrierId, setFreshCarrierId] = useState<string | null>(null);
  useEffect(() => {
    if (freshCarrierId === null) return;
    const content = rootRef.current?.querySelector<HTMLElement>(
      `[data-block-id="${freshCarrierId}"] .nt-block-content`,
    );
    if (content === null || content === undefined) return;
    setFreshCarrierId(null);
    content.click();
  });
  /** Fallback cells (dead) by `${schema}:${idx}` — the pass skips a
   *  cell while IT holds the caret (its writes commit on blur). */
  const fallbackInputsRef = useRef(new Map<string, HTMLInputElement>());
  const registerFallbackInput = (key: string) => (el: HTMLInputElement | null) => {
    if (el === null) fallbackInputsRef.current.delete(key);
    else fallbackInputsRef.current.set(key, el);
  };

  // S5 block-to-property drop: the row is a drop target of the ONE
  // workspace drag session. While a block drag is live (DragSourcesContext)
  // the row reads the shared decision matrix for its affordance — offered
  // (empty slots ring) vs refused (no-drop cursor); the plan re-runs at
  // release time in the host, so nothing here writes.
  const dragSources = useContext(DragSourcesContext);
  const dragBlockId =
    dragSources === null || dragSources.size === 0 ? null : [...dragSources][0]!;
  const propertyDrop = useWorkspaceDndPropertyDrop(
    { ownerNodeId: nodeId, propertySchemaId, client },
    { disabled: readOnly },
  );
  const dropVerdict =
    dragBlockId !== null && propertyDrop.enabled
      ? propertyDropVerdict(client, {
          blockId: dragBlockId,
          ownerNodeId: nodeId,
          propertySchemaId,
        })
      : "noop";
  const setRowRef = (el: HTMLLIElement | null) => {
    rootRef.current = el;
    propertyDrop.setNodeRef(el);
  };

  /**
   * Auto-unset pass (header contract): unset every authored value that is
   * contentless — a scalar empty string, a dead carrier ref, or a carrier
   * with no text and no children. The unset trashes the carrier, so a
   * carrier is skipped while focus is anywhere inside THIS row (an Add/Enter
   * just minted an empty value the user is about to type into); the
   * focusout handler re-runs the pass once the caret leaves.
   */
  const cleanupEmptyValues = (): void => {
    const rowHasFocus = rootRef.current?.contains(document.activeElement) === true;
    // Fresh rows straight from the client — the `rows` prop can be a stale
    // pre-unset snapshot (the row re-renders off its own subscription), and
    // unsetting from stale rows would loop forever.
    const fresh = client
      .getEffectiveProperties(nodeId)
      .filter(
        (row) => row.propertySchemaId === propertySchemaId && row.source === "authored",
      );
    for (const row of fresh) {
      const state = carrierStateOf(client, row.value);
      if (state.kind === "carrier") {
        const node = client.getNode(state.id);
        if (node === undefined) continue;
        const contentless =
          plainTextExcerpt(node.contentAst).trim() === "" && client.getChildren(state.id).length === 0;
        if (!contentless) continue;
        if (rowHasFocus) continue;
        void client.unsetProperty(nodeId, propertySchemaId, row.idx);
        continue;
      }
      if (fallbackInputsRef.current.get(`${propertySchemaId}:${row.idx}`) === document.activeElement) {
        continue;
      }
      if (state.kind === "dead") {
        // Gone entirely (no node row) → contentless by definition: unset. A
        // node that exists but no longer renders as an inline block keeps
        // the recovery cell (the dead-input re-author path).
        const ref =
          typeof row.value === "object" && row.value !== null && "nodeId" in row.value
            ? String((row.value as { nodeId: unknown }).nodeId ?? "")
            : typeof row.value === "string"
              ? row.value
              : "";
        if (ref !== "" && client.getNode(ref) === undefined) {
          void client.unsetProperty(nodeId, propertySchemaId, row.idx);
        }
        continue;
      }
      if (typeof row.value === "string" && row.value.trim() === "") {
        void client.unsetProperty(nodeId, propertySchemaId, row.idx);
      }
    }
  };

  // Run the pass after every store-synced render — local edits, remote syncs,
  // and mount over legacy data all funnel through the subscription's version
  // bump into a re-render. Unsetting re-renders once more and the pass
  // settles (nothing left to unset). Read-only skips the pass entirely: it
  // only ever writes.
  useEffect(() => {
    if (!readOnly) cleanupEmptyValues();
  });

  const addValue = async (): Promise<void> => {
    setAddError(null);
    try {
      const carrier = await client.createObject({
        parentId: nodeId,
        contentAst: [{ type: "text", text: "" }],
      });
      await client.setProperty(nodeId, propertySchemaId, { nodeId: carrier }, nextIdx, manualEditMetadata);
      // The realize hand-off (the ghost contract): the fresh-carrier effect
      // opens the block editor on the minted value, like Enter/Add today.
      setFreshCarrierId(carrier);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * Mint-on-edit for a legacy scalar string: the established create-carrier
   * pattern (object.create + property.set with the {nodeId} ref — the Add
   * pill and the dead-cell re-author ride the same two ops), the string
   * becoming the carrier's content. `editor: false` skips the fresh-carrier
   * editor hand-off (the context-menu path opens the NODE MENU on the minted
   * carrier instead).
   */
  const mintCarrierFor = async (
    text: string,
    idx: number,
    opts: { editor?: boolean } = {},
  ): Promise<string | null> => {
    setAddError(null);
    try {
      const carrierId = await client.createObject({
        parentId: nodeId,
        contentAst: [{ type: "text", text }],
      });
      await client.setProperty(nodeId, propertySchemaId, { nodeId: carrierId }, idx, manualEditMetadata);
      if (opts.editor !== false) setFreshCarrierId(carrierId);
      return carrierId;
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  /**
   * The scalar row's right-click: mint the carrier WITHOUT the editor
   * hand-off, then open the node context menu ON the minted carrier — the
   * scalar isn't a node yet, so the menu gesture materializes it first (the
   * ghost-realize precedent), and from then on the row renders the real
   * BlockRow whose own grip menu works.
   */
  const [scalarMenu, setScalarMenu] = useState<{ x: number; y: number; carrierId: string } | null>(
    null,
  );
  const mintForMenu = async (text: string, idx: number, x: number, y: number): Promise<void> => {
    if (readOnly) return;
    const carrierId = await mintCarrierFor(text, idx, { editor: false });
    if (carrierId !== null) setScalarMenu({ x, y, carrierId });
  };

  /**
   * The empty-state cell: the platform GHOST ROW (ui/GhostRow — the same
   * muted "+ Add block" affordance the outliner trails) — the 2026-11-02
   * ruling: empty text properties wear the ghost idiom, not a field. The
   * realize click mints an EMPTY carrier and opens the block editor on it
   * (the fresh-carrier effect); walking away without typing leaves the
   * auto-unset pass to reclaim the slot. An optional trailing affordance
   * (the citekey regenerate) rides the row's right edge.
   */
  const emptyCell = (key: string, idx: number, trailing?: ReactNode): ReactNode => (
    <div key={key} className="nt-property-ghost">
      <GhostRow parentId={nodeId} onRealize={() => void mintCarrierFor("", idx)} />
      {trailing ?? null}
    </div>
  );

  return (
    <li
      ref={setRowRef}
      onBlur={(event) => {
        // Focus truly left the row (React's onBlur is the bubbling focusout —
        // it also fires on carrier-to-carrier hops, so filter those): the
        // user has LEFT any freshly-minted empty carrier, so re-run the
        // auto-unset pass — an abandoned empty value goes now, not at the
        // next unrelated store update. Read-only never writes.
        if (readOnly) return;
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        cleanupEmptyValues();
      }}
      className={
        (allDefault
          ? `nt-property nt-property-default nt-property-text node-metadata-row${rowClassName}`
          : `nt-property nt-property-text node-metadata-row${rowClassName}`) +
        // The bullet IS the multi-value discriminator (the owner's ruling:
        // multi rows show it, single rows hide it) — everything else is
        // uniform between the two.
        (multi ? " nt-property-text--multi" : " nt-property-text--single") +
        (dropVerdict !== "noop" ? " nt-property--droppable" : "") +
        (propertyDrop.isOver && dropVerdict !== "noop" ? " nt-property--drop-over" : "") +
        (dragBlockId !== null && propertyDrop.enabled && dropVerdict === "noop"
          ? " nt-property--no-drop"
          : "")
      }
    >
      {!bare && (
        <>
          <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>
            <Icon path={icon} size={0.8} className="nt-property-name__icon" />
            {label}
            {classSourced && <span className="nt-property-hint" title="From a class">C</span>}
          </span>
          {citekeyPinButton}
          {allDefault && <span className="nt-property-hint">default</span>}
          {unbound && <span className="nt-property-hint">unbound</span>}
        </>
      )}
      <span className="nt-property-textcell">
        <CarrierEnterContext.Provider
          value={{ carrierOf: (blockId) => carrierInfo.get(blockId) ?? null }}
        >
          {carrierItems.length > 0 && (
            <NodeCollection
              viewMode="outline"
              client={client}
              items={carrierItems}
              tree
              showBreadcrumbs={false}
              // Value rows wear ONE chrome: the list-projection idiom (the
              // hubs' precedent) — per-row backlink/property/tag chrome is
              // data-dependent noise on a value, so every root reads the
              // same bullet-less block row and only children keep theirs.
              hideBacklinkCount
              hideProperties
              hideTags
              {...(readOnly ? { readOnly: true } : { editable: true })}
              renderItem={(item, row) => (
                <CarrierRowHost client={client} item={item} onOpenPage={onOpenPage} onOpenInSidebar={onOpenInSidebar}>
                  {row}
                </CarrierRowHost>
              )}
            />
          )}
          {ordered.map((row) => {
            const state = carrierStateOf(client, row.value);
            // Carrier values render as the locked collection's root items
            // above; only the fallback cells ride this map.
            if (state.kind === "carrier") return null;
            // Assigned/bound-empty row: the declaration exists, no
            // value yet — the cell authors the first CARRIER block on
            // edit, the node-backed convention (the same handler the
            // bound-but-empty cell rides).
            if (row.value === null) {
              if (readOnly) {
                return (
                  <span
                    key={row.elementId}
                    className="nt-property-value nt-property-value--readonly"
                  />
                );
              }
              return emptyCell(row.elementId, 0);
            }
            // Legacy scalar string (a plain-string value that is not a
            // carrier ref — the retired `url` type's shape, pre-carrier text
            // values): renders inline as plain text, linkified per the
            // markdownLinks grammar; the first edit mints a carrier block
            // carrying the string and opens the block editor on it. A DEAD
            // carrier (a uuid that no longer resolves) keeps the recovery
            // input: display EMPTY, re-author a fresh carrier on edit, unset
            // on empty blur.
            const dead = state.kind === "dead";
            if (!dead) {
              const scalarText = typeof row.value === "string" ? row.value : "";
              const scalarTokens = [{ type: "text", text: scalarText }];
              if (readOnly) {
                return (
                  <span
                    key={`${propertySchemaId}:${row.idx}`}
                    className="nt-property-value nt-property-value--readonly"
                  >
                    {scalarText === "" ? null : <InlineTokens tokens={scalarTokens} />}
                  </span>
                );
              }
              // A default-sourced SCALAR EMPTY STRING (the citekey seed's
              // `defaultValue: ""`) is an empty FIELD, not a value: it
              // renders the SAME "Empty" placeholder block row as a
              // bound-but-empty row. The click still mints the carrier (the
              // established mint-on-edit semantics, unchanged); the citekey
              // regenerate affordance rides the row's right edge.
              if (scalarText === "" && row.source === "default") {
                return emptyCell(`${propertySchemaId}:${row.idx}`, row.idx, citekeyRegenButton(row.idx));
              }
              // The scalar rides a BLOCK ROW — the same bullet + content
              // shape the carrier rows render (every text value reads as a
              // block, single-value rows included); the click mints the
              // carrier (the established pattern) and the fresh-carrier
              // effect opens the block editor on it; the right-click mints
              // and opens the NODE CONTEXT MENU on it (the scalar isn't a
              // node yet — the menu gesture materializes it first).
              const menuFor = (event: React.MouseEvent): void => {
                event.preventDefault();
                event.stopPropagation();
                void mintForMenu(scalarText, row.idx, event.clientX, event.clientY);
              };
              return (
                <div
                  key={`${propertySchemaId}:${row.idx}`}
                  className="nt-block nt-property-scalar-block"
                  data-block-id={`scalar:${propertySchemaId}:${row.idx}`}
                >
                  <div className="nt-block-row" onContextMenu={menuFor}>
                    <span
                      className="nt-bullet"
                      title={`Edit ${label}`}
                      onClick={() => void mintCarrierFor(scalarText, row.idx)}
                    >
                      <span className="nt-bullet-dot" aria-hidden="true" />
                    </span>
                    <button
                      type="button"
                      className="nt-block-content nt-property-scalar-content"
                      aria-label={`Edit property ${label}`}
                      onClick={() => void mintCarrierFor(scalarText, row.idx)}
                      onContextMenu={menuFor}
                    >
                      <InlineTokens tokens={scalarTokens} />
                    </button>
                    {citekeyRegenButton(row.idx)}
                  </div>
                </div>
              );
            }
            if (readOnly) {
              return (
                <span
                  key={`${propertySchemaId}:${row.idx}`}
                  className="nt-property-value nt-property-value--readonly"
                />
              );
            }
            return (
              <input
                key={`${propertySchemaId}:${row.idx}`}
                ref={registerFallbackInput(`${propertySchemaId}:${row.idx}`)}
                type="text"
                className="nt-property-value"
                defaultValue=""
                aria-label={`Property ${label}`}
                onBlur={(event) => {
                  const text = event.target.value;
                  if (text.trim() === "") {
                    void client.unsetProperty(nodeId, propertySchemaId, row.idx);
                    return;
                  }
                  void (async () => {
                    const carrierId = await client.createObject({
                      parentId: nodeId,
                      contentAst: [{ type: "text", text }],
                    });
                    await client.setProperty(
                      nodeId,
                      propertySchemaId,
                      { nodeId: carrierId },
                      row.idx,
                    );
                  })();
                }}
              />
            );
          })}
          {ordered.length === 0 && readOnly ? null : ordered.length === 0 && (
            // No declaration and no values: the same ghost row — the click
            // mints the first carrier and opens the block editor on it.
            emptyCell("empty", 0)
          )}
          {!readOnly && multi && ordered.some((row) => row.value !== null) && (
            // The trailing realize ghost — the platform idiom, the empty-state
            // cell's twin (no AddPill): one click mints an empty carrier at
            // the next idx and opens the block editor on it (the fresh-carrier
            // effect). Only once VALUES exist — an empty row's own ghost
            // covers the realize; single-value rows trail none (their empty
            // state owns the cell's ghost).
            <div className="nt-property-ghost">
              <GhostRow parentId={nodeId} onRealize={() => void addValue()} />
            </div>
          )}
        </CarrierEnterContext.Provider>
        {scalarMenu !== null &&
          (() => {
            const node = client.getNode(scalarMenu.carrierId);
            if (node === undefined) return null;
            return (
              <NodeContextMenu
                state={{ x: scalarMenu.x, y: scalarMenu.y, node, isPage: false }}
                client={client}
                onClose={() => setScalarMenu(null)}
                onOpenNode={(id) => {
                  setScalarMenu(null);
                  onOpenPage?.(id);
                }}
              />
            );
          })()}
        {addError !== null && (
          <p role="alert" className="nt-picker-error">
            {addError}
          </p>
        )}
      </span>
    </li>
  );
}
