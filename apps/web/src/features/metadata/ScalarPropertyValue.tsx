import { rendersAsInlineBlock } from "@notees/domain";

import type { EffectiveProperty } from "@/core/workspace-client/index.js";

import { parentRenderFacts } from "../../ui/renderStateLabel.js";
import { propertyLinkHref } from "../collection/propertyDisplay.js";
import { Icon } from "../../ui/Icon.js";
import { ReferenceSubtree } from "../block-editor/ReferenceSubtree.js";
import type { AnyClient } from "./shared.js";
import { fromEditableText, toEditableText } from "./shared.js";

/**
 * ScalarPropertyValue — the value cell of a scalar (ungrouped) property
 * row: a node-backed carrier block renders its editable subtree; anything
 * else rides the minimal text editor (a dead carrier reference renders
 * EMPTY, never the raw uuid — typing authors a fresh carrier, leaving it
 * empty unsets the dead value). An ASSIGNED-EMPTY row (owner ruling
 * 2026-10-23 — property.assign without a value) renders the same cell
 * empty; the first edit authors the value, an empty blur writes nothing.
 * Shared by the properties table and the sidebar; the row chrome (label,
 * hints, li wrapper) stays at the call sites.
 */
export function ScalarPropertyValue({
  client,
  nodeId,
  row,
  onOpenPage,
  /** Read-only projection: the carrier renders read-only, scalars as text. */
  readOnly = false,
}: {
  client: AnyClient;
  nodeId: string;
  row: EffectiveProperty;
  onOpenPage?: ((pageId: string) => void) | undefined;
  readOnly?: boolean | undefined;
}) {
  // Text properties are node-backed: the value references a carrier
  // block — {"nodeId"} after migration, a bare uuid string in archived
  // data. Render the block, editable, in place of the raw input when it
  // resolves to a block.
  const editable = toEditableText(row.value);
  const rawRef =
    typeof row.value === "object" && row.value !== null && "nodeId" in (row.value as object)
      ? String((row.value as { nodeId: unknown }).nodeId)
      : typeof editable === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(editable)
        ? editable
        : null;
  const rawNode = rawRef !== null ? client.getNode(rawRef) : undefined;
  const carrier =
    rawNode !== undefined && rendersAsInlineBlock(rawNode, parentRenderFacts(client, rawNode))
      ? rawNode
      : undefined;
  // Dead carrier (owner bug report 2026-10-04): the value references a
  // carrier block that was deleted/trashed from the value cell. The
  // content is GONE — display EMPTY, never the raw uuid; editing authors
  // a fresh carrier, and touching it empty cleans the dead value row (so
  // the uuid does not survive reloads).
  const deadCarrierRef = rawRef !== null && carrier === undefined;
  const editableText = deadCarrierRef ? "" : toEditableText(row.value);
  // Url/email scalars keep the text editor and gain an
  // external-link affordance (mailto: for email; url values keep their
  // authored scheme, tel: included).
  const linkHref = propertyLinkHref(row.schema?.type, row.value);
  return (
    <>
      {carrier !== undefined ? (
        <span className="nt-property-blockcell">
          <ReferenceSubtree client={client} rootId={carrier.id} onOpenNode={onOpenPage} readOnly={readOnly} />
        </span>
      ) : readOnly ? (
        <span className="nt-property-value nt-property-value--readonly">
          {editableText === "" ? null : String(editableText)}
        </span>
      ) : (
        <input
          key={`${row.propertySchemaId}:${row.idx}:${editableText}`}
          type="text"
          className="nt-property-value"
          defaultValue={editableText}
          aria-label={`Property ${row.schema?.name ?? row.propertySchemaId}`}
          onBlur={(event) => {
            const text = event.target.value;
            // Assigned-empty row (owner ruling 2026-10-23 — property.assign
            // without a value): nothing is authored yet — an empty blur
            // keeps the declaration as-is (no empty-string value is minted);
            // the first real edit authors the value through property.set.
            if (row.value === null && text.trim() === "") return;
            if (deadCarrierRef) {
              // The old carrier is gone: typing authors a NEW carrier
              // (the established create-carrier pattern); leaving it empty unsets the dead
              // value so the row does not hold a dangling ref.
              if (text.trim() === "") {
                void client.unsetProperty(nodeId, row.propertySchemaId, row.idx);
              } else {
                void (async () => {
                  const carrierId = await client.createObject({
                    parentId: nodeId,
                    contentAst: [{ type: "text", text }],
                  });
                  await client.setProperty(
                    nodeId,
                    row.propertySchemaId,
                    { nodeId: carrierId },
                    row.idx,
                  );
                })();
              }
              return;
            }
            const next = fromEditableText(text);
            // Deep-compare so a no-op blur never enqueues a write.
            if (JSON.stringify(next) !== JSON.stringify(row.value)) {
              void client.setProperty(nodeId, row.propertySchemaId, next, row.idx);
            }
          }}
        />
      )}
      {linkHref !== null && (
        <a
          className="nt-property-link"
          href={linkHref}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${row.schema?.name ?? row.propertySchemaId}`}
        >
          <Icon path="mdi-open-in-new" size={0.7} />
        </a>
      )}
    </>
  );
}
