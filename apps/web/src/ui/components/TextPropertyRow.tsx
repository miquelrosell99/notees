/**
 * TextPropertyRow — one text property rendered as a BLOCKS LIST
 * (owner ruling): a single property row whose values are the carrier blocks
 * themselves (editable, children and all) — never repeated "label: value"
 * entries per value.
 *
 * The carriers render through the shared collection dispatcher: a locked
 * outline NodeCollection (no view switcher), one root item per carrier, each
 * root row hosted in its own per-carrier outliner context — the same editing
 * context the standalone subtree renderer used to host, so bullet navigation,
 * collapse, and the keyboard gestures behave exactly as they did there.
 *
 * Enter semantics ride the CarrierEnterContext (see textCarrier.ts):
 *  - multi-value: Enter on a value creates a SIBLING block registered as the
 *    next property value;
 *  - single-value: Enter nests a CHILD block under the carrier — the value
 *    is one block whose children are its lines.
 *
 * Values that don't resolve to a carrier block (legacy scalar strings) keep
 * the minimal text input fallback; editing a dead-carrier cell re-authors a
 * fresh carrier, empty-blur unsets the dead value. A bound-but-empty row
 * renders the full-width "Type something" placeholder input so the empty
 * value cell still reads as a field; typing authors the first carrier.
 *
 * Auto-unset (owner 2026-10-09): an authored value whose carrier has no
 * content and no child blocks is unset automatically — a dead ref whose
 * target node is gone counts as contentless (one that exists but no longer
 * renders inline keeps the recovery cell) — so clearing a text property
 * returns the slot to its empty state instead of lingering as an empty block
 * or a dead cell. The pass runs on every store-synced render and when focus
 * leaves the row; a carrier is skipped while focus is inside the row (an
 * Add/Enter just minted an empty value the user may be about to type into)
 * and unsetting trashes the carrier — "Unset deletes the carrier".
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { plainTextExcerpt, rendersAsInlineBlock } from "@notees/domain";

import type { EffectiveProperty } from "@/core/workspace-client.js";

import { NodeCollection, type NodeCollectionItem } from "../views/index.js";
import type { AnyClient } from "../views/types.js";
import { AddPill } from "./ui/AddPill.js";
import { OutlinerContext, useOutlinerValue } from "../outliner-context.js";
import { CarrierEnterContext, type CarrierInfo } from "../textCarrier.js";

/** Cycle-protection depth cap, mirroring the client's getBlockTree default. */
const CARRIER_TREE_DEPTH_CAP = 64;

/** Mirror of the metadata scalar branch's carrier resolution. */
function carrierStateOf(
  client: AnyClient,
  value: unknown,
): { kind: "carrier"; id: string } | { kind: "dead" } | { kind: "scalar" } {
  const rawRef =
    typeof value === "object" && value !== null && "nodeId" in (value as Record<string, unknown>)
      ? String((value as { nodeId: unknown }).nodeId ?? "")
      : typeof value === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        ? value
        : null;
  if (rawRef !== null) {
    const node = client.getNode(rawRef);
    if (node !== undefined && rendersAsInlineBlock(node)) return { kind: "carrier", id: rawRef };
    return { kind: "dead" };
  }
  return { kind: "scalar" };
}

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
 * bullet click opens the node — the row never wired a sidebar peek). The
 * collection's default row renders inside the provider, so BlockRow resolves
 * THIS context instead of the enclosing page's.
 */
function CarrierRowHost({
  client,
  item,
  onOpenPage,
  children,
}: {
  client: AnyClient;
  item: NodeCollectionItem;
  onOpenPage?: ((pageId: string) => void) | undefined;
  children: ReactNode;
}) {
  const outliner = useOutlinerValue(client, item.node.id, {
    openNode: (id) => onOpenPage?.(id),
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
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  rows: EffectiveProperty[];
  onOpenPage?: ((pageId: string) => void) | undefined;
  bare?: boolean;
}) {
  const ordered = [...rows].sort((a, b) => a.idx - b.idx);
  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const unbound = rows.some((row) => row.source === "authored" && row.boundBy === null);
  const [addError, setAddError] = useState<string | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  // The standalone subtree renderer carried its own subscription per carrier
  // root so the cell stays live even outside a subscribing host; the row
  // keeps that contract with one subscription for all its carriers.
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

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
  /** Fallback cells (dead/scalar) by `${schema}:${idx}` — the pass skips a
   *  cell while IT holds the caret (its writes commit on blur). */
  const fallbackInputsRef = useRef(new Map<string, HTMLInputElement>());
  const registerFallbackInput = (key: string) => (el: HTMLInputElement | null) => {
    if (el === null) fallbackInputsRef.current.delete(key);
    else fallbackInputsRef.current.set(key, el);
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
        if (rowHasFocus) continue;
        const node = client.getNode(state.id);
        if (node === undefined) continue;
        if (plainTextExcerpt(node.contentAst).trim() === "" && client.getChildren(state.id).length === 0) {
          void client.unsetProperty(nodeId, propertySchemaId, row.idx);
        }
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
  // settles (nothing left to unset).
  useEffect(() => {
    cleanupEmptyValues();
  });

  const addValue = async (): Promise<void> => {
    setAddError(null);
    try {
      const carrier = await client.createObject({
        parentId: nodeId,
        contentAst: [{ type: "text", text: "" }],
      });
      await client.setProperty(nodeId, propertySchemaId, { nodeId: carrier }, nextIdx);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <li
      ref={rootRef}
      onBlur={(event) => {
        // Focus truly left the row (React's onBlur is the bubbling focusout —
        // it also fires on carrier-to-carrier hops, so filter those): re-run
        // the auto-unset pass so an abandoned empty value goes now, not at
        // the next unrelated store update.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        cleanupEmptyValues();
      }}
      className={
        allDefault
          ? "nt-property nt-property-default nt-property-text node-metadata-row"
          : "nt-property nt-property-text node-metadata-row"
      }
    >
      {!bare && (
        <>
          <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>
            {label}
          </span>
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
              editable
              renderItem={(item, row) => (
                <CarrierRowHost client={client} item={item} onOpenPage={onOpenPage}>
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
            // Dead carrier (uuid value that no longer resolves): display
            // EMPTY, re-author a fresh carrier on edit, unset on empty blur.
            // Scalar values: the minimal text editor, writing the string.
            const dead = state.kind === "dead";
            const editableText = typeof row.value === "string" && !dead ? row.value : "";
            return (
              <input
                key={`${propertySchemaId}:${row.idx}:${editableText}`}
                ref={registerFallbackInput(`${propertySchemaId}:${row.idx}`)}
                type="text"
                className="nt-property-value"
                defaultValue={editableText}
                aria-label={`Property ${label}`}
                onBlur={(event) => {
                  const text = event.target.value;
                  if (dead && text.trim() === "") {
                    void client.unsetProperty(nodeId, propertySchemaId, row.idx);
                    return;
                  }
                  if (text === editableText) return;
                  void (async () => {
                    if (dead) {
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
                      return;
                    }
                    await client.setProperty(nodeId, propertySchemaId, text, row.idx);
                  })();
                }}
              />
            );
          })}
          {ordered.length === 0 && (
            // The empty cell still spans the full value width (owner
            // 2026-10-09) — the muted placeholder names the field empty;
            // typing authors the first carrier block, like the Add pill but
            // with the text riding in directly.
            <input
              type="text"
              className="nt-property-value"
              placeholder="Type something"
              aria-label={`Property ${label}`}
              onBlur={(event) => {
                const text = event.target.value;
                if (text.trim() === "") return;
                void (async () => {
                  const carrierId = await client.createObject({
                    parentId: nodeId,
                    contentAst: [{ type: "text", text }],
                  });
                  await client.setProperty(nodeId, propertySchemaId, { nodeId: carrierId }, 0);
                })();
              }}
            />
          )}
          {multi && ordered.length > 0 && (
            <AddPill
              ref={addButtonRef}
              label="Add"
              onClick={() => void addValue()}
            />
          )}
        </CarrierEnterContext.Provider>
        {addError !== null && (
          <p role="alert" className="nt-picker-error">
            {addError}
          </p>
        )}
      </span>
    </li>
  );
}
