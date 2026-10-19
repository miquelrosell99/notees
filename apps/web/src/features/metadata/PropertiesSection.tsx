import { Icon } from "../../ui/Icon.js";
import { NodeViewSection } from "../page-sections/NodeViewSection.js";
import type { AnyClient } from "./shared.js";
import { propertiesCountOf, propertyGroupsOf } from "./propertyGroups.js";
import { AliasesRow } from "./AliasesRow.js";
import { PropertiesTable } from "./PropertiesTable.js";

/**
 * PropertiesSection — the page's "Metadata N" section (note layout; owner
 * 2026-10-09: the properties panel is named Metadata, and the aliases row —
 * relocated from the title-row button — rides its top as the first
 * section): every property field in the table, collapsed by default.
 * Classes and tags are identity rows in the page header, not properties —
 * the count covers property rows only. Hosts may hide the WHOLE section
 * when the count is 0 (PageView: embedded renders — the journal and
 * calendar day feeds — drop the section and its divider together, owner
 * 2026-10-09).
 */
export function PropertiesSection({
  client,
  nodeId,
  onOpenPage,
  onOpenPageRaw = undefined,
  hideWhenEmpty = false,
  omitDisplayPositions,
  /** Read-only projection: values render statically (the read-only block
   *  row keeps the panel aligned with its editable twin). */
  readOnly = false,
}: {
  client: AnyClient;
  nodeId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** The RAW open for the aliases row's pill (bypasses the alias redirect). */
  onOpenPageRaw?: ((pageId: string) => void) | undefined;
  /** Block mode: render nothing when the node carries no properties. */
  hideWhenEmpty?: boolean | undefined;
  /** Schema display positions the host renders itself (the block
   *  row's bullet/inline icon buttons) — rows carrying them are filtered
   *  out of this panel so the value never reads twice. */
  omitDisplayPositions?: ReadonlyArray<"bullet" | "inline"> | undefined;
  readOnly?: boolean | undefined;
}) {
  const count = propertiesCountOf(propertyGroupsOf(client, nodeId, omitDisplayPositions));
  if (hideWhenEmpty && count === 0) return null;
  return (
    <NodeViewSection
      title="Properties"
      icon={<Icon path="mdi-format-list-bulleted-square" size={0.9} />}
      count={count}
      className="node-metadata-section nt-properties-panel"
      defaultExpanded={false}
    >
      <div className="node-metadata-content">
        {/* The aliases list is the panel's first section — pages only (the
            row renders null for blocks, so BlockRow's hideWhenEmpty usage
            gains no empty chrome). */}
        <AliasesRow client={client} nodeId={nodeId} onOpenPage={onOpenPage} onOpenPageRaw={onOpenPageRaw} readOnly={readOnly} />
        <PropertiesTable
          client={client}
          nodeId={nodeId}
          onOpenPage={onOpenPage}
          omitDisplayPositions={omitDisplayPositions}
          readOnly={readOnly}
        />
      </div>
    </NodeViewSection>
  );
}
