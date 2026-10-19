/**
 * MetadataSection — the page's effective-properties panel (renamed
 * "Metadata").
 *
 * Rows:
 *  - the panel's FIRST section is the aliases row (relocated from the
 *    title-row AliasesButton): every alias of the page as pills with an ×
 *    each + "+ Add alias" (the backward write over the picker's pick);
 *  - the node's classes as colored pills (× unassigns; right-click opens the
 *    color-swatch menu) + a "+ Add class" ghost pill opening the ported
 *    node-selector popup (search / create / pick, client.assignClass);
 *  - MULTI-value node-typed values render as pills — the same NodePill
 *    element the nodeview classes list renders, tinted with the linked
 *    node's effective color; the picker is the ported NodeSelector popup
 *    (search + create, filtered by the schema's target classes, upload for
 *    asset targets);
 *  - SINGLE-value node-typed and date values render as the full-width
 *    selection dropdown (PropertySelectCell): the content area shows the
 *    selected node as a read-only block row (the date's display name —
 *    never a pill), empty shows the muted "Select" placeholder; the picker
 *    (NodeSelector / DatePickerPopup) anchors at the trigger, the clear
 *    affordance unsets the slot;
 *  - asset values render as the dedicated asset list (thumbnail + name +
 *    remove) with the Upload / Link authoring buttons (the asset picker is
 *    asset-scoped with create disabled; the upload runs in the
 *    AssetUploadModal);
 *  - select schemas with options render the ported options control
 *    (pills + picker), booleans a checkbox, everything else the minimal
 *    text editor; empty text cells render the full-width "Type something"
 *    placeholder input. Derived defaults stay dimmed with a "default" hint,
 *    authored values win, unbound survivors are marked.
 *  - the properties sidebar separates its properties with a hairline under
 *    each row; empty value cells keep the column's full width so they read
 *    as empty fields.
 *
 * The nt-* class hooks the tests assert on (.nt-properties-panel,
 * .nt-property-*, .nt-classes-row, …) are unchanged.
 */

import { useState } from "react";

import {
  rendersAsInlineBlock,
  SYSTEM_PROPERTY_UUIDS,
  type DatePrecision,
} from "@notees/domain";

import type {
  ClassBinding,
  EffectiveProperty,
  PropertyDisplay,
} from "@/core/workspace-client.js";

import { parentRenderFacts } from "../renderStateLabel.js";
import { Icon } from "../Icon.js";
import { NodeViewSection } from "./NodeViewSection.js";
import { IconPickerPopup } from "./IconPickerPopup.js";
import { SelectionButton } from "./ui/SelectionButton.js";
import { ToggleSwitch } from "./ui/ToggleSwitch.js";
import { ReferenceSubtree } from "./ReferenceSubtree.js";
import { propertyLinkHref } from "../views/propertyDisplay.js";
import { cssColorFor } from "./ui/colorPresets.js";
import { ContextMenu } from "./ui/ContextMenu.js";
import { Modal } from "./ui/Modal.js";
import { Button } from "./ui/Button.js";
import { ColorButton } from "./ui/ColorButton.js";
import { PropertyView } from "./PropertyView.js";
import { PropertyConvertModal } from "./PropertyConvertModal.js";
import { PropertyHistoryModal } from "./PropertyHistoryModal.js";
import { TextPropertyRow } from "./TextPropertyRow.js";
import { AliasedNodeRow } from "./AliasedNodeRow.js";
import {
  type AnyClient,
  fromEditableText,
  toEditableText,
} from "./metadata/shared.js";
import { ObjectPropertyRow } from "./metadata/ObjectPropertyRow.js";
import { AssetPropertyRow } from "./metadata/AssetPropertyRow.js";
import { DatetimePropertyRow } from "./metadata/DatetimePropertyRow.js";
import { SelectPropertyRow } from "./metadata/SelectPropertyRow.js";
import { BooleanPropertyRow } from "./metadata/BooleanPropertyRow.js";
import { AliasesRow } from "./metadata/AliasesRow.js";
import { AddPropertyRow } from "./metadata/AddPropertyRow.js";
import "./MetadataSection.css";

// The identity rows are hosted by PageChrome/BlockRow/CardsView through this
// historical import surface — re-exported, not composed here.
export { ClassesRow } from "./metadata/ClassesRow.js";
export { TagsRow } from "./metadata/TagsRow.js";


/**
 * The property-rows model shared by the Metadata section (blocks) and the
 * Properties section (pages): effective rows grouped per schema, plus the
 * bound-but-empty grouped bindings that still render an add affordance.
 *
 * `omitDisplayPositions` filters out rows whose SCHEMA carries a
 * bullet/inline value-display position (the render contracts are
 * property-level; the block row surfaces those values itself — the panel
 * must not duplicate them). The same filter applies to the bound-but-empty
 * bindings, whose add affordance the block row's icon button already covers.
 */
function propertyGroupsOf(
  client: AnyClient,
  nodeId: string,
  omitDisplayPositions?: ReadonlyArray<"bullet" | "inline">,
) {
  const omittedByDisplay = (display: PropertyDisplay | null): boolean =>
    (display === "bullet" || display === "inline") &&
    (omitDisplayPositions?.includes(display) ?? false);
  const node = client.getNode(nodeId);
  // Class pages: the class's has-template values render in the dedicated
  // Templates section — the generic table suppresses that schema row. The
  // cover schema is suppressed EVERYWHERE: the cover is header
  // chrome (PageBanner/AddCover), never a property row.
  const isClassNode = node?.isClass === true;
  const rows = client
    .getEffectiveProperties(nodeId)
    .filter(
      (row) =>
        !(isClassNode && row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.hasTemplate) &&
        row.propertySchemaId !== SYSTEM_PROPERTY_UUIDS.cover &&
        !omittedByDisplay(row.display),
    );

  // Node-typed / datetime / boolean / text schemas render as one
  // grouped row per schema; the `asset` type joins the family with its
  // dedicated row (the upload/link chrome + the multi asset list).
  // Select AND multi_select schemas join them only when they declare
  // options (without options the minimal text editor is the honest editor —
  // there is nothing to pick; the shape routes multi_select to the selection
  // control). Text groups render as a blocks list (the carrier blocks
  // themselves). Grouped rows appear at their first occurrence so the panel
  // order is unchanged.
  const optionsOf = (propertySchemaId: string) =>
    client.listPropertySchemas().find((s) => s.id === propertySchemaId)?.options;
  const isGroupedType = (type: string | undefined, propertySchemaId: string): boolean => {
    if (type === "object" || type === "asset" || type === "datetime" || type === "boolean" || type === "text") {
      return true;
    }
    if (type === "select" || type === "multi_select") {
      const options = optionsOf(propertySchemaId);
      return options !== null && options !== undefined && options.length > 0;
    }
    return false;
  };

  const renderedGroups = new Set<string>();
  const rendered = rows.map((row) => {
    const type = row.schema?.type;
    if (!isGroupedType(type, row.propertySchemaId)) {
      return { kind: "scalar" as const, row };
    }
    if (renderedGroups.has(row.propertySchemaId)) return null;
    renderedGroups.add(row.propertySchemaId);
    return {
      kind: "grouped" as const,
      propertySchemaId: row.propertySchemaId,
      type,
      groupRows: rows.filter((r) => r.propertySchemaId === row.propertySchemaId),
    };
  });

  // A bound grouped property with no effective rows still renders: the row
  // hosts the add/set affordance (the scalar editor has no way to author a
  // first value). hide-when-empty schemas are the exception: the
  // render contracts are property-level — read from the schema row, not the
  // binding).
  const emptyObjectBindings: ClassBinding[] = [];
  for (const classId of node?.classIds ?? []) {
    for (const binding of client.getClassBindings(classId)) {
      if (!isGroupedType(binding.type, binding.propertySchemaId)) continue;
      if (isClassNode && binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS.hasTemplate) continue;
      if (binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS.cover) continue;
      const schemaRow = client.listPropertySchemas().find((s) => s.id === binding.propertySchemaId);
      if (omittedByDisplay(schemaRow?.display ?? null)) continue;
      if (renderedGroups.has(binding.propertySchemaId)) continue;
      if (emptyObjectBindings.some((b) => b.propertySchemaId === binding.propertySchemaId)) continue;
      if (schemaRow?.hideWhenEmpty === true) continue;
      emptyObjectBindings.push(binding);
    }
  }

  return { rows, rendered, emptyObjectBindings };
}

type PropertyGroups = ReturnType<typeof propertyGroupsOf>;

/** Visible table rows: scalars + one per grouped schema + empty bindings. */
function propertiesCountOf(groups: PropertyGroups): number {
  return groups.rendered.filter((entry) => entry !== null).length + groups.emptyObjectBindings.length;
}

/**
 * The node's effective metadata row count — the section's emptiness test.
 * Exported for hosts that gate sibling chrome on it (PageView hides the
 * whole in-flow section, divider included, on empty embedded renders — the
 * journal and calendar day feeds).
 */
export function metadataRowCount(client: AnyClient, nodeId: string): number {
  return propertiesCountOf(propertyGroupsOf(client, nodeId));
}

/**
 * PropertiesTable — the property rows and the add affordance, shared by the
 * Metadata section (blocks) and the Properties section (pages).
 *
 * Property interactions: clicking a property LABEL opens the
 * property's configuration (PropertySettingsModal); right-clicking it opens
 * the context menu (Open property / Empty property / Remove from node).
 * Both ride event delegation on the list — the label spans carry
 * `data-property-schema-id`.
 */
/**
 * GroupedPropertyRow — one row per grouped schema (node-typed / datetime /
 * boolean / text always; select schemas once they declare options), the
 * per-type value-row component chosen by schema type.
 * Shared by the properties table and the properties sidebar.
 */
function GroupedPropertyRow({
  client,
  nodeId,
  type,
  propertySchemaId,
  label,
  multi,
  schema,
  bindingFilter,
  groupRows,
  onOpenPage,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
  /** Read-only projection: the value renders statically, no mutation UI. */
  readOnly = false,
}: {
  client: AnyClient;
  nodeId: string;
  type: string | undefined;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  schema: { datePrecision?: DatePrecision | null } | null;
  bindingFilter: string[] | null;
  groupRows: EffectiveProperty[];
  onOpenPage?: ((pageId: string) => void) | undefined;
  bare?: boolean;
  readOnly?: boolean | undefined;
}) {
  if (type === "datetime") {
    return (
      <DatetimePropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={multi}
        schema={schema}
        rows={groupRows}
        bare={bare}
        readOnly={readOnly}
      />
    );
  }
  if (type === "select" || type === "multi_select") {
    const options =
      client.listPropertySchemas().find((s) => s.id === propertySchemaId)?.options ?? [];
    return (
      <SelectPropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={type === "multi_select" ? true : multi}
        options={options}
        rows={groupRows}
        bare={bare}
        readOnly={readOnly}
      />
    );
  }
  if (type === "boolean") {
    return (
      <BooleanPropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        rows={groupRows}
        bare={bare}
        readOnly={readOnly}
      />
    );
  }
  if (type === "text") {
    return (
      <TextPropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={multi}
        rows={groupRows}
        onOpenPage={onOpenPage}
        bare={bare}
        readOnly={readOnly}
      />
    );
  }
  if (type === "asset") {
    return (
      <AssetPropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={multi}
        rows={groupRows}
        bare={bare}
        readOnly={readOnly}
      />
    );
  }
  return (
    <ObjectPropertyRow
      client={client}
      nodeId={nodeId}
      propertySchemaId={propertySchemaId}
      label={label}
      multi={multi}
      bindingFilter={bindingFilter}
      rows={groupRows}
      onOpenPage={onOpenPage}
      bare={bare}
      readOnly={readOnly}
    />
  );
}

/**
 * ScalarPropertyValue — the value cell of a scalar (ungrouped) property
 * row: a node-backed carrier block renders its editable subtree; anything
 * else rides the minimal text editor (a dead carrier reference renders
 * EMPTY, never the raw uuid — typing authors a fresh carrier, leaving it
 * empty unsets the dead value). Shared by the properties table and the
 * sidebar; the row chrome (label, hints, li wrapper) stays at the call
 * sites.
 */
function ScalarPropertyValue({
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
  // Dead carrier: the value references a
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

export function PropertiesTable({
  client,
  nodeId,
  onOpenPage,
  omitDisplayPositions,
  /** Read-only projection: values render statically; no add/label menus. */
  readOnly = false,
}: {
  client: AnyClient;
  nodeId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** Schema display positions (bullet/inline) the host surfaces
   *  itself — filter out. */
  omitDisplayPositions?: ReadonlyArray<"bullet" | "inline"> | undefined;
  readOnly?: boolean | undefined;
}) {
  const { rows, rendered, emptyObjectBindings } = propertyGroupsOf(client, nodeId, omitDisplayPositions);
  const labelOf = (row: EffectiveProperty): string => row.schema?.name ?? row.propertySchemaId;
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [viewFor, setViewFor] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ schemaId: string; x: number; y: number } | null>(null);

  const schemaIdFromEvent = (event: React.SyntheticEvent): string | null => {
    const target = event.target as HTMLElement;
    const label = target.closest<HTMLElement>("[data-property-schema-id]");
    return label?.dataset.propertySchemaId ?? null;
  };

  const isBound = (schemaId: string): boolean => {
    const node = client.getNode(nodeId);
    for (const classId of node?.classIds ?? []) {
      if (client.getClassBindings(classId).some((b) => b.propertySchemaId === schemaId)) return true;
    }
    return false;
  };
  const isReadonly = (schemaId: string): boolean =>
    rows.some((r) => r.propertySchemaId === schemaId && r.readonly === true);
  const emptyProperty = (schemaId: string) => {
    for (const row of rows) {
      if (row.propertySchemaId === schemaId && row.source === "authored") {
        void client.setProperty(nodeId, schemaId, "", row.idx);
      }
    }
  };
  const removeFromNode = (schemaId: string) => {
    for (const row of rows) {
      if (row.propertySchemaId === schemaId && row.source === "authored") {
        void client.unsetProperty(nodeId, schemaId, row.idx);
      }
    }
  };

  const menuItems = (schemaId: string) => {
    const bound = isBound(schemaId);
    const readonly = isReadonly(schemaId);
    return [
      { id: "open", label: "Open property", icon: "mdi-open-in-app", onClick: () => setSettingsFor(schemaId) },
      {
        id: "history",
        label: "Value history…",
        icon: "mdi-history",
        onClick: () => setHistoryFor(schemaId),
      },
      {
        id: "empty",
        label: "Empty property",
        icon: "mdi-eraser",
        disabled: readonly,
        onClick: () => emptyProperty(schemaId),
      },
      {
        id: "remove",
        label: "Remove from node",
        icon: "mdi-close-circle-outline",
        danger: true,
        disabled: bound || readonly,
        onClick: () => removeFromNode(schemaId),
      },
    ];
  };


  const groupedRow = (
    type: string | undefined,
    propertySchemaId: string,
    label: string,
    multi: boolean,
    schema: { datePrecision?: DatePrecision | null } | null,
    bindingFilter: string[] | null,
    groupRows: EffectiveProperty[],
  ) => (
    <GroupedPropertyRow
      key={propertySchemaId}
      client={client}
      nodeId={nodeId}
      type={type}
      propertySchemaId={propertySchemaId}
      label={label}
      multi={multi}
      schema={schema}
      bindingFilter={bindingFilter}
      groupRows={groupRows}
      onOpenPage={onOpenPage}
      readOnly={readOnly}
    />
  );

  return (
    <>
      <ul
        className="nt-properties-list"
        onClick={(event) => {
          if (readOnly) return;
          const schemaId = schemaIdFromEvent(event);
          if (schemaId !== null) setSettingsFor(schemaId);
        }}
        onContextMenu={(event) => {
          if (readOnly) return;
          const schemaId = schemaIdFromEvent(event);
          if (schemaId === null) return;
          event.preventDefault();
          event.stopPropagation();
          setMenu({ schemaId, x: event.clientX, y: event.clientY });
        }}
      >
          {/* The alias-side pseudo-property: chrome over the `aliasedNodeId`
              node field itself (null for every ordinary node). */}
          <AliasedNodeRow client={client} nodeId={nodeId} onOpenPage={onOpenPage} readOnly={readOnly} />
          {rendered.map((entry) => {
            if (entry === null) return null;
            if (entry.kind === "grouped") {
              const schema = entry.groupRows[0]?.schema ?? null;
              return groupedRow(
                entry.type,
                entry.propertySchemaId,
                schema?.name ?? entry.propertySchemaId,
                schema?.multi ?? true,
                schema,
                null,
                entry.groupRows,
              );
            }
            const row = entry.row;
            const label = labelOf(row);
            return (
              <li
                key={`${row.propertySchemaId}:${row.idx}`}
                className={
                  row.source === "default"
                    ? "nt-property nt-property-default node-metadata-row"
                    : "nt-property node-metadata-row"
                }
              >
                <span className="section-label nt-property-name" data-property-schema-id={row.propertySchemaId}>
                  {label}
                  {row.boundBy !== null && <span className="nt-property-hint" title="From a class">C</span>}
                </span>
                <ScalarPropertyValue client={client} nodeId={nodeId} row={row} onOpenPage={onOpenPage} readOnly={readOnly} />
              </li>
            );
          })}
          {(readOnly ? emptyObjectBindings.filter((binding) =>
              // Read-only: a bound-but-empty binding renders nothing (no add
              // affordance) — skip the row rather than render a bare label.
              rows.some((row) => row.propertySchemaId === binding.propertySchemaId),
            ) : emptyObjectBindings).map((binding) =>
            groupedRow(
              binding.type,
              binding.propertySchemaId,
              binding.name,
              binding.multi,
              { datePrecision: binding.datePrecision },
              binding.targetClassFilter,
              [],
            ),
          )}
      </ul>
      {!readOnly && <AddPropertyRow client={client} nodeId={nodeId} />}
      {menu !== null && (
        <ContextMenu items={menuItems(menu.schemaId)} position={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />
      )}
      {settingsFor !== null && (
        <PropertySettingsModal
          client={client}
          propertySchemaId={settingsFor}
          onClose={() => setSettingsFor(null)}
          onOpenView={() => {
            setViewFor(settingsFor);
            setSettingsFor(null);
          }}
        />
      )}
      {viewFor !== null && (
        <PropertyView
          client={client}
          propertySchemaId={viewFor}
          onClose={() => setViewFor(null)}
          onOpenPage={(id) => {
            setViewFor(null);
            onOpenPage?.(id);
          }}
        />
      )}
      {historyFor !== null && (
        <PropertyHistoryModal
          client={client}
          nodeId={nodeId}
          propertySchemaId={historyFor}
          schemaName={
            client.listPropertySchemas().find((s) => s.id === historyFor)?.name ?? historyFor
          }
          onClose={() => setHistoryFor(null)}
        />
      )}
    </>
  );
}

/**
 * PropertiesSection — the page's "Metadata N" section (note layout; the properties panel is named Metadata, and the aliases row —
 * relocated from the title-row button — rides its top as the first
 * section): every property field in the table, collapsed by default.
 * Classes and tags are identity rows in the page header, not properties —
 * the count covers property rows only. Hosts may hide the WHOLE section
 * when the count is 0 (PageView: embedded renders — the journal and
 * calendar day feeds — drop the section and its divider together).
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

/**
 * PropertiesSidebar — the main layout's first column:
 * a set of rows, one per property — a property-name row followed by its
 * value-cell row — beside a continuous vertical divider (the sidebar's
 * right edge runs the card's full height, no top or bottom gap). The rows
 * ride a collapsible NodeViewSection: the section header names the column — dotted-list icon +
 * "Metadata" + the effective row count — and collapsing keeps the
 * column's divider while the rows step aside. The panel's FIRST section is
 * the aliases row (relocated from the title-row button): every alias of the
 * page as pills with an × each, "+ Add alias" riding the pages-only picker
 * (the backward write, exactly like the retired popup). The value cells
 * reuse the properties table's row components verbatim (only their internal
 * label/hints hide — the name row above carries them); only the two-row
 * stacking and the divider are this component's own. Clicking a name row
 * opens the property's settings, like the table's label click.
 */
export function PropertiesSidebar({
  client,
  nodeId,
  onOpenPage,
  onOpenPageRaw = undefined,
}: {
  client: AnyClient;
  nodeId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** The RAW open for the aliases row's pill (bypasses the alias redirect). */
  onOpenPageRaw?: ((pageId: string) => void) | undefined;
}) {
  const groups = propertyGroupsOf(client, nodeId);
  const { rendered, emptyObjectBindings } = groups;
  const count = propertiesCountOf(groups);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [viewFor, setViewFor] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ schemaId: string; x: number; y: number } | null>(null);
  const labelOf = (row: EffectiveProperty): string => row.schema?.name ?? row.propertySchemaId;

  const hintOf = (rows: EffectiveProperty[]): string | null =>
    rows.some((row) => row.boundBy !== null) ? "C" : null;

  // The name row's right-click menu rides the same actions as the table's
  // label (Open property / Value history / Empty / Remove).
  const rowsOf = rendered.flatMap((entry) =>
    entry === null ? [] : entry.kind === "grouped" ? entry.groupRows : [entry.row],
  );
  const isBound = (schemaId: string): boolean => {
    const node = client.getNode(nodeId);
    for (const classId of node?.classIds ?? []) {
      if (client.getClassBindings(classId).some((b) => b.propertySchemaId === schemaId)) return true;
    }
    return false;
  };
  const isReadonly = (schemaId: string): boolean =>
    rowsOf.some((r) => r.propertySchemaId === schemaId && r.readonly === true);
  const emptyProperty = (schemaId: string) => {
    for (const row of rowsOf) {
      if (row.propertySchemaId === schemaId && row.source === "authored") {
        void client.setProperty(nodeId, schemaId, "", row.idx);
      }
    }
  };
  const removeFromNode = (schemaId: string) => {
    for (const row of rowsOf) {
      if (row.propertySchemaId === schemaId && row.source === "authored") {
        void client.unsetProperty(nodeId, schemaId, row.idx);
      }
    }
  };
  const menuItems = (schemaId: string) => {
    const bound = isBound(schemaId);
    const readonly = isReadonly(schemaId);
    return [
      { id: "open", label: "Open property", icon: "mdi-open-in-app", onClick: () => setSettingsFor(schemaId) },
      {
        id: "history",
        label: "Value history…",
        icon: "mdi-history",
        onClick: () => setHistoryFor(schemaId),
      },
      {
        id: "empty",
        label: "Empty property",
        icon: "mdi-eraser",
        onClick: () => emptyProperty(schemaId),
        disabled: readonly,
      },
      {
        id: "remove",
        label: "Remove from node",
        icon: "mdi-close-circle-outline",
        onClick: () => removeFromNode(schemaId),
        danger: true,
        disabled: bound || readonly,
      },
    ];
  };

  const nameRow = (propertySchemaId: string, label: string, hint: string | null) => (
    <button
      type="button"
      className="nt-props-sidebar__name nt-property-name"
      data-property-schema-id={propertySchemaId}
      onClick={() => setSettingsFor(propertySchemaId)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ schemaId: propertySchemaId, x: event.clientX, y: event.clientY });
      }}
    >
      {label}
      {hint !== null && (
        <span className="nt-property-hint" title={hint === "C" ? "From a class" : undefined}>
          {hint}
        </span>
      )}
    </button>
  );

  return (
    <div className="nt-props-sidebar">
      <NodeViewSection
        title="Properties"
        icon={<Icon path="mdi-format-list-bulleted" size={0.9} />}
        count={count}
        className="nt-props-sidebar__section"
        defaultExpanded={true}
      >
        {/* The aliases row is the panel's first section (relocated from the
            title-row button): the node's own aliases as pills + the add
            picker; the raw open keeps the retired popup's NAVIGATE bypass. */}
        <AliasesRow client={client} nodeId={nodeId} onOpenPage={onOpenPage} onOpenPageRaw={onOpenPageRaw} />
        {/* The alias-side pseudo-property rides the sidebar's row stack too
            (only when the node IS an alias — the row renders null otherwise
            and the wrapper must not leave an empty slot). */}
        {client.getNode(nodeId)?.aliasedNodeId != null && (
          <div className="nt-props-sidebar__prop">
            <AliasedNodeRow client={client} nodeId={nodeId} onOpenPage={onOpenPage} />
          </div>
        )}
        {rendered.map((entry) => {
        if (entry === null) return null;
        if (entry.kind === "grouped") {
          const schema = entry.groupRows[0]?.schema ?? null;
          const label = schema?.name ?? entry.propertySchemaId;
          return (
            <div className="nt-props-sidebar__prop" key={entry.propertySchemaId}>
              {nameRow(entry.propertySchemaId, label, hintOf(entry.groupRows))}
              <div className="nt-props-sidebar__value">
                <GroupedPropertyRow
                  client={client}
                  nodeId={nodeId}
                  type={entry.type}
                  propertySchemaId={entry.propertySchemaId}
                  label={label}
                  multi={schema?.multi ?? true}
                  schema={schema}
                  bindingFilter={null}
                  groupRows={entry.groupRows}
                  onOpenPage={onOpenPage}
                  bare
                />
              </div>
            </div>
          );
        }
        const row = entry.row;
        return (
          <div className="nt-props-sidebar__prop" key={`${row.propertySchemaId}:${row.idx}`}>
            {nameRow(
              row.propertySchemaId,
              labelOf(row),
              row.boundBy !== null ? "C" : null,
            )}
            <div className="nt-props-sidebar__value">
              <ScalarPropertyValue client={client} nodeId={nodeId} row={row} onOpenPage={onOpenPage} />
            </div>
          </div>
        );
      })}
      {emptyObjectBindings.map((binding) => (
        <div className="nt-props-sidebar__prop" key={`empty-${binding.propertySchemaId}`}>
          {nameRow(binding.propertySchemaId, binding.name, null)}
          <div className="nt-props-sidebar__value">
            <GroupedPropertyRow
              client={client}
              nodeId={nodeId}
              type={binding.type}
              propertySchemaId={binding.propertySchemaId}
              label={binding.name}
              multi={binding.multi}
              schema={{ datePrecision: binding.datePrecision }}
              bindingFilter={binding.targetClassFilter}
              groupRows={[]}
              onOpenPage={onOpenPage}
              bare
            />
          </div>
        </div>
      ))}
        <AddPropertyRow client={client} nodeId={nodeId} />
      </NodeViewSection>
      {menu !== null && (
        <ContextMenu items={menuItems(menu.schemaId)} position={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />
      )}
      {historyFor !== null && (
        <PropertyHistoryModal
          client={client}
          nodeId={nodeId}
          propertySchemaId={historyFor}
          schemaName={
            client.listPropertySchemas().find((s) => s.id === historyFor)?.name ?? historyFor
          }
          onClose={() => setHistoryFor(null)}
        />
      )}
      {settingsFor !== null && (
        <PropertySettingsModal
          client={client}
          propertySchemaId={settingsFor}
          onClose={() => setSettingsFor(null)}
          onOpenView={() => {
            setViewFor(settingsFor);
            setSettingsFor(null);
          }}
        />
      )}
      {viewFor !== null && (
        <PropertyView
          client={client}
          propertySchemaId={viewFor}
          onClose={() => setViewFor(null)}
          onOpenPage={(id) => {
            setViewFor(null);
            onOpenPage?.(id);
          }}
        />
      )}
    </div>
  );
}

/**
 * PropertySettingsModal — the property's "page" for configuration (opened by
 * clicking a property label in the table). The schemas are registry rows,
 * so the configuration surface is this modal:
 * rename, per-type behavior (date precision / qualified, select options),
 * and the property-level render contracts (value display, read-
 * only, hide when empty), the single home for those. Type and multi are
 * create-time contracts and display read-only. The "Open property" footer
 * path surfaces the schema inspector (PropertyView): metadata,
 * bound classes, and the authored-value references.
 */
function PropertySettingsModal({
  client,
  propertySchemaId,
  onClose,
  onOpenView,
}: {
  client: AnyClient;
  propertySchemaId: string;
  onClose: () => void;
  onOpenView: () => void;
}) {
  const schema = client.listPropertySchemas().find((s) => s.id === propertySchemaId);
  const [convertOpen, setConvertOpen] = useState(false);
  /** The option whose icon picker is open (+ its anchor button). */
  const [iconPickerFor, setIconPickerFor] = useState<{
    optionId: string;
    anchor: HTMLElement;
  } | null>(null);
  if (schema === undefined) return null;

  const patch = (fields: Parameters<AnyClient["updatePropertySchema"]>[1]) =>
    void client.updatePropertySchema(propertySchemaId, fields);

  return (
    <Modal isOpen onClose={onClose} size="sm" showCloseButton={false} className="nt-property-settings">
      <div className="modal__header">
        <h2 className="modal__title">Property settings</h2>
        <button type="button" aria-label="Close modal" className="btn btn--ghost btn--sm btn--icon-only modal__close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="modal__content">
        <label className="nt-property-settings__field">
          <span className="nt-property-settings__label">Name</span>
          <input
            key={schema.id}
            type="text"
            className="nt-property-settings__input"
            defaultValue={schema.name}
            aria-label="Property name"
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name !== "" && name !== schema.name) patch({ name });
            }}
          />
        </label>
        <p className="nt-property-settings__meta">
          Type: {schema.type}
          {schema.multi ? " (multi)" : ""}
        </p>
        {/* The render contracts are PROPERTY-level — the single home
            for editing them is this settings surface. Value display rides
            the types the block-row button renders (select / multi_select /
            boolean); read-only and hide-when-empty are type-agnostic. The
            wire stores "panel" / null explicitly. */}
        {(schema.type === "select" || schema.type === "multi_select" || schema.type === "boolean") && (
          <label className="nt-property-settings__field">
            <span className="nt-property-settings__label">Value display</span>
            <SelectionButton
              size="sm"
              aria-label="Value display"
              options={[
                { value: "panel", icon: "mdi-format-list-bulleted-square", label: "Properties panel" },
                { value: "bullet", icon: "mdi-circle-medium", label: "Next to bullet" },
                { value: "inline", icon: "mdi-format-align-left", label: "Before content" },
              ]}
              value={schema.display ?? "panel"}
              onChange={(value) => patch({ display: value as PropertyDisplay })}
            />
          </label>
        )}
        <label className="nt-property-settings__field">
          <span className="nt-property-settings__label">Read-only</span>
          <ToggleSwitch
            size="sm"
            leftLabel="Editable"
            rightLabel="Read-only"
            checked={schema.readonly === true}
            onChange={(value) => patch({ readonly: value ? true : null })}
            aria-label="Read-only"
          />
        </label>
        <label className="nt-property-settings__field">
          <span className="nt-property-settings__label">Hide when empty</span>
          <ToggleSwitch
            size="sm"
            leftLabel="Always show"
            rightLabel="Hide when empty"
            checked={schema.hideWhenEmpty === true}
            onChange={(value) => patch({ hideWhenEmpty: value ? true : null })}
            aria-label="Hide when empty"
          />
        </label>
        {schema.type === "datetime" && (
          <>
            <label className="nt-property-settings__field">
              <span className="nt-property-settings__label">Precision</span>
              <select
                className="nt-property-settings__input"
                aria-label="Date precision"
                value={schema.datePrecision ?? "day"}
                onChange={(event) =>
                  patch({ datePrecision: event.target.value as DatePrecision })
                }
              >
                <option value="day">Day</option>
                <option value="month">Month</option>
                <option value="year">Year</option>
              </select>
            </label>
            <label className="nt-property-settings__check">
              <input
                type="checkbox"
                checked={schema.dateQualified ?? false}
                onChange={(event) => patch({ dateQualified: event.target.checked })}
                aria-label="Date range qualifiers"
              />
              <span>Allow start/end qualifiers</span>
            </label>
          </>
        )}
        {schema.type === "select" && (
          <div className="nt-property-settings__field">
            <span className="nt-property-settings__label">Options</span>
            <ul className="nt-property-settings__options">
              {(schema.options ?? []).map((option) => (
                <li key={option.id} className="nt-property-settings__option">
                  {/* Per-option MDI icon (the picker's trash action
                      emits "" = clear; the wholesale options write preserves
                      ids like the ColorButton path above). */}
                  <button
                    type="button"
                    className="nt-property-settings__option-icon"
                    title={`Icon for ${option.label}`}
                    aria-label={`Icon for ${option.label}`}
                    onClick={(event) =>
                      setIconPickerFor({ optionId: option.id, anchor: event.currentTarget })
                    }
                  >
                    {option.icon ? (
                      <Icon
                        path={option.icon}
                        size={0.7}
                        {...(option.color ? { color: cssColorFor(option.color) } : {})}
                      />
                    ) : (
                      <Icon path="mdi-plus-circle-outline" size={0.7} />
                    )}
                  </button>
                  {/* Per-option color dot (the color grammar; none = uncolored). */}
                  <ColorButton
                    color={option.color ?? ""}
                    size="xs"
                    showPicker
                    showNoneOption
                    aria-label={`Color for ${option.label}`}
                    onColorChange={(color) =>
                      patch({
                        options: (schema.options ?? []).map((o) =>
                          o.id === option.id ? { ...o, color } : o,
                        ),
                      })
                    }
                  />
                  <input
                    key={`${option.id}:${option.label}`}
                    type="text"
                    className="nt-property-settings__input"
                    defaultValue={option.label}
                    aria-label={`Option ${option.label}`}
                    onBlur={(event) => {
                      const label = event.target.value.trim();
                      if (label === "" || label === option.label) return;
                      patch({
                        options: (schema.options ?? []).map((o) =>
                          o.id === option.id ? { ...o, label } : o,
                        ),
                      });
                    }}
                  />
                  <button
                    type="button"
                    className="pill__right-button"
                    aria-label={`Remove option ${option.label}`}
                    onClick={() =>
                      patch({
                        options: (schema.options ?? []).filter((o) => o.id !== option.id),
                      })
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                patch({
                  options: [
                    ...(schema.options ?? []),
                    { id: crypto.randomUUID(), label: "New option" },
                  ],
                })
              }
            >
              + Add option
            </Button>
            {iconPickerFor !== null && (
              <IconPickerPopup
                value={
                  schema.options?.find((option) => option.id === iconPickerFor.optionId)?.icon ??
                  ""
                }
                anchorEl={iconPickerFor.anchor}
                onClose={() => setIconPickerFor(null)}
                onSelect={(value) =>
                  patch({
                    options: (schema.options ?? []).map((option) =>
                      option.id === iconPickerFor.optionId
                        ? { ...option, icon: value === "" ? null : value }
                        : option,
                    ),
                  })
                }
              />
            )}
          </div>
        )}
      </div>
      <div className="modal__footer">
        {/* PG3: the blessed delete+recreate conversion flow (one honest
            flow — Capacities-style keep-original machinery is NOT built). */}
        <Button variant="ghost" onClick={() => setConvertOpen(true)}>
          Convert…
        </Button>
        <Button variant="ghost" onClick={onOpenView}>
          Open property
        </Button>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
      {convertOpen && (
        <PropertyConvertModal client={client} schema={schema} onClose={() => setConvertOpen(false)} />
      )}
    </Modal>
  );
}
