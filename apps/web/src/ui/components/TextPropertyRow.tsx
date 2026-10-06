/**
 * TextPropertyRow — one text property rendered as a BLOCKS LIST
 * (owner ruling): a single property row whose values are the carrier blocks
 * themselves (editable, children and all) — never repeated "label: value"
 * entries per value.
 *
 * Enter semantics ride the CarrierEnterContext (see textCarrier.ts):
 *  - multi-value: Enter on a value creates a SIBLING block registered as the
 *    next property value;
 *  - single-value: Enter nests a CHILD block under the carrier — the value
 *    is one block whose children are its lines.
 *
 * Values that don't resolve to a carrier block (legacy scalar strings) keep
 * the minimal text input fallback; editing a dead-carrier cell re-authors a
 * fresh carrier, empty-blur unsets the dead value.
 */

import { useMemo, useRef, useState } from "react";

import { rendersAsInlineBlock } from "@notees/domain";

import type { EffectiveProperty } from "@/core/workspace-client.js";

import type { AnyClient } from "../views/types.js";
import { AddPill } from "./ui/AddPill.js";
import { ReferenceSubtree } from "./ReferenceSubtree.js";
import { CarrierEnterContext, type CarrierInfo } from "../textCarrier.js";

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

  const nextIdx = (() => {
    const authored = ordered.filter((row) => row.source === "authored").map((row) => row.idx);
    return authored.length > 0 ? Math.max(...authored) + 1 : 0;
  })();

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
          {ordered.map((row) => {
            const state = carrierStateOf(client, row.value);
            if (state.kind === "carrier") {
              return (
                <ReferenceSubtree
                  key={`${propertySchemaId}:${row.idx}`}
                  client={client}
                  rootId={state.id}
                  onOpenNode={onOpenPage}
                />
              );
            }
            // Dead carrier (uuid value that no longer resolves): display
            // EMPTY, re-author a fresh carrier on edit, unset on empty blur.
            // Scalar values: the minimal text editor, writing the string.
            const dead = state.kind === "dead";
            const editableText = typeof row.value === "string" && !dead ? row.value : "";
            return (
              <input
                key={`${propertySchemaId}:${row.idx}:${editableText}`}
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
          {multi && (
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
