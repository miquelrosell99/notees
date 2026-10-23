/**
 * TableView — the table mode, extended:
 *
 * - Columns: Name (fixed) + Classes/Created/Edited + property columns resolved by
 *   the container; a "Columns" panel toggles built-ins and adds/removes any
 *   workspace property (session state, defaults from the container). The
 *   Edited column rides `node.updatedAt` in the user's date format.
 * - Sort: per-column header click sets a single quick sort; the "Sort"
 *   panel manages the full multi-column SortSpec list (add/remove,
 *   direction toggle, priority reorder). Sort resolution reads every column
 *   (hidden included) so a sort survives its column being hidden. With no
 *   container `defaultSort` the table renders the container's row order
 *   (query results keep the query's order); the hubs pass Edited-desc. The
 *   container's default stays LIVE: it re-seeds the sort while the user
 *   has chosen none (the ranked quick search rides this — see
 *   ClassedNodesSection).
 * - Rows: windowed (the shared useWindowed convention: "Show more
 *   (N remaining)" at the list's end, the window resets on every sort
 *   change); row checkboxes with a tri-state header box when `selectable`
 *   (default on) — selection is session state. The header box selects the
 *   LOADED window (labeled so); exports and counts always read the full set.
 *   Rows are ALWAYS flat — one row per item, children never render, whatever
 *   the tree/maxDepth props say (owner 2026-10-13, the cards-mode ruling's
 *   twin: cards always resolve children, table never shows them).
 * - Cells: boolean + select edit inline; url/email and number/integer
 *   commit on blur/Enter (empty unsets) through the cell-level inline input;
 *   date cells open the canonical date-picker popup (suggestions / All-day /
 *   Range / Remove) writing the unified datetime union (ensureDateChain);
 *   node cells open the anchored NodeSelector — the single-value cell as a
 *   picker on the value, the MULTI-value cell (owner 2026-10-21) as the
 *   metadata row's pill cluster: every value a NodePill (open on click,
 *   hover-reveal × unsets its slot) plus an "+ Add <name>" pill appending at
 *   the next free idx through the anchored NodeSelector (the schema's
 *   targetClassFilter scopes the search AND the create row).
 *   TEXT cells (owner 2026-10-21) ride the name cell's contract: the value
 *   IS a carrier block, so the cell renders it through BlockRow
 *   variant="title" (read mode renders the carrier's inline tokens; a click
 *   swaps in the full block editor; leaving the editor emptied unsets the
 *   property and the orphaned carrier is trashed) — the retired bordered
 *   inline input flattened rich text to edit it. An empty (or broken-ref)
 *   text cell renders the muted "Empty" placeholder (owner 2026-10-21 — one
 *   click creates the carrier and lands straight in the editor, BlockRow
 *   autoEdit; the button names the action "Add <name>" for assistive tech).
 *   ASSET cells (owner 2026-10-21) mirror the metadata asset row: every
 *   value a pill whose click DOWNLOADS the asset, with the ❝ annotations
 *   toggle opening the annotations panel anchored under the cell, and the
 *   "+ Add <name>" pill's picker create row IS the upload action ("Upload
 *   file…" → AssetUploadModal → the uploaded asset links at the next free
 *   idx; single-value schemas replace their authored slot).
 *   Multi-value properties other than node/asset-typed stay read-only
 *   (every value renders, joined).
 * - The navigate button (owner 2026-10-20, extended 2026-10-21): the pinned
 *   Open button rides every cell that names a target — the name cell, the
 *   single-value node/date property cells, TEXT cells with a carrier (opens
 *   the carrier's page), and the Created/Edited stamps (owner 2026-10-21:
 *   the retired click-to-navigate day link — date TEXT never navigates, it
 *   edits (editable value click → picker) or reads (readonly plain text);
 *   navigation is the button's alone). The VALUE click owns the picker
 *   (unless read-only), the button owns navigation (target node / day
 *   page), hover-revealed like the name cell.
 * - The empty-state placeholders (owner 2026-10-21, settled same day): an
 *   empty VALUE cell reads "Empty" — the muted state placeholder idiom —
 *   across text, node, date, asset, and scalar cells (the click on a picker
 *   cell names its action "Add <name>" for assistive tech). The pill
 *   clusters' "+ Add <name>" pills keep the action label — they are the add
 *   affordance itself, the metadata row's idiom.
 * - Name cell (owner 2026-10-21): the node's title IS a block row — the
 *   page header's title projection (BlockRow variant="title"): inline
 *   tokens render read mode (markdown links render as links, class chips
 *   resolve — never the raw-source text flatten), and a click inside the
 *   cell swaps in the full block editor (the title variant's relaxed
 *   contract: Enter flushes and leaves edit, no split/structural
 *   gestures). The pinned Open button — the workspace card's "Open
 *   workspace" twin (ghost/sm, right arrow, owner 2026-10-20) — owns
 *   navigation: click opens, shift+click peeks the node in the sidebar
 *   card. The peek rides the container's `onNodeShiftClick`, falling
 *   back to the enclosing OutlinerContext's `openInSidebar` (CardsView's
 *   precedent) so un-wired hosts (the class page's Classed nodes
 *   section, query blocks) peek too. The rows consume an OutlinerContext,
 *   so the table hosts its OWN (the FlatCards precedent — visible[0]'s
 *   node as the root id): the enclosing page/class view is the navigation
 *   fallback, the shell hubs have none of their own.
 * - Column sizing (owner 2026-10-21): the table rides fixed layout with a
 *   colgroup — every column has a DEFAULT width (name 32ch, classes 16ch,
 *   created/edited 12ch, isClass/isEmbedded 8ch, properties 18ch — ch units
 *   in the table font) and a user drag on a header divider commits a px
 *   width (session-state, like the rest of the table chrome), clamped at
 *   that default — the default IS the minimum, a column widens from its
 *   default and never narrows below it; the divider is keyboard-reachable
 *   too (ArrowLeft/Right nudge 16px). Fixed layout makes the widths exact —
 *   cell content wraps inside its lane, and a crowded table scrolls the
 *   wrap horizontally instead of renegotiating columns from content (auto
 *   layout starved the name column to its nested-flex min-content, found
 *   by the live probe).
 * - CSV export: the toolbar "…" menu's "Export CSV"
 *   downloads the CURRENT view — the visible columns × the full sorted
 *   result set (the window is display-only, never an export cut) — through
 *   @notees/export's renderCsv (RFC-4180 quoting + UTF-8 BOM for Excel), and
 *   a live selection additionally offers "Export selected CSV" — the same
 *   columns scoped to exactly the checked rows. A selection also offers
 *   "Export selected…": the export modal's batch path over just the checked
 *   row ids (the parked "selection-scoped export").
 * - Excel export + import (issue #9): the "…" menu's "Export Excel" writes
 *   the same view as a minimal .xlsx (a leading uuid column then the visible
 *   labels, typed number cells) so the sheet round-trips through
 *   "Import table…", which reads .csv/.xlsx back — uuid rows update
 *   properties, rows without one create nodes — through the ImportTableModal.
 * - The toolbar's far-right "…" menu carries the table's data actions
 *   (Export CSV / Export Excel / Import table…) at the view-type level,
 *   next to the Columns/Sort configurators.
 */

import { useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { isRangeDatetimeValue, isReadonlyProperty, isValidTimeOfDay, parseDateNodeId, fullTitleOf, plainTextExcerpt, SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { renderCsv, renderXlsx, type XlsxCell } from "@notees/export";

import { BooleanToggle, Button, ButtonWithPanel, Checkbox, ContextMenu, AddPill } from "../../components/ui/fleet/index.js";
import { Icon } from "../../ui/Icon.js";
import { BlockRow } from "../../ui/BlockRow.js";
import { NodeSelector } from "../pickers/NodeSelector.js";
import { NodePill } from "../metadata/NodePills.js";
import { isAssetClass, resolveTargetClassIds } from "../metadata/shared.js";
import { AnnotationsSection } from "../../ui/AnnotationsSection.js";
import { AssetUploadModal } from "../modals/AssetUploadModal.js";
import { usePopupDismissal } from "../../components/ui/fleet/usePopupDismissal.js";
import {
  DatePickerPopup,
  type DatetimePickerSlot,
} from "../date-pickers/DatePickerPopup.js";
import { collectMarkedDates } from "../date-pickers/DateSlotControl.js";
import { ExportPageModal } from "../export/ExportPageModal.js";
import { ImportTableModal } from "../modals/ImportTableModal.js";
import { downloadBlob } from "../modals/download.js";
import { exportTimestamp } from "../export/exportSubtree.js";
import { nodeIcon } from "../../ui/iconFor.js";
import { OutlinerContext, useOutlinerValue } from "../../ui/outliner-context.js";
import { nodeDisplayName, displayNameFromClient, labelFromClient, datetimeValueText, formatIsoDate } from "../../ui/dateDisplay.js";
import { registerView } from "./registry.js";
import { useWindowed } from "./useWindowed.js";
import { ShowMoreButton } from "./ShowMoreButton.js";
import { useViewChromeTarget } from "./viewChrome.js";
import { createPortal } from "react-dom";
import { isEmptyPropertyValue, propertyDisplayText, propertyLinkHref } from "./propertyDisplay.js";
import type { ClientNode, EffectiveProperty } from "@/core/workspace-client/index.js";
import type {
  AnyClient,
  NodeCollectionItem,
  NodeCollectionProps,
  SortSpec,
  TableColumn,
} from "./types.js";
import "./TableView.css";

/** Rows per window. */
const ROW_WINDOW = 100;

/**
 * The fixed-layout share per column kind (ch units — the table font's
 * character box; the property default rides the common header length).
 * The DEFAULT IS THE MINIMUM (owner 2026-10-21): a column renders at its
 * default and a drag can only widen it from there — it never comes back
 * narrower than the default. The name column rides 32ch, the lane the
 * flexible auto-layout column claimed. Fixed layout ignores the td's
 * min-width, so the share is a real col width here, not a CSS minimum.
 */
function defaultColumnWidth(column: TableColumn): string {
  if (column.kind === "name") return "32ch";
  if (column.kind === "classes") return "16ch";
  if (column.kind === "created" || column.kind === "edited") return "12ch";
  if (column.kind === "isClass" || column.kind === "isEmbedded") return "8ch";
  return "18ch";
}

/**
 * A column kind's minimum in px — its default ch share resolved against
 * the table font (measured with a 10ch probe; the fallback only rides a
 * zero-size jsdom box, where layout doesn't run anyway).
 */
function columnMinimumWidth(column: TableColumn, table: HTMLTableElement | null): number {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;width:10ch;";
  (table?.querySelector("th") ?? document.body).appendChild(probe);
  const ch = probe.getBoundingClientRect().width / 10;
  probe.remove();
  const perCh = ch > 0 ? ch : 9;
  return Math.round(parseFloat(defaultColumnWidth(column)) * perCh);
}

const DEFAULT_COLUMNS: TableColumn[] = [
  { id: "name", kind: "name", label: "Name", sortable: true },
  { id: "classes", kind: "classes", label: "Classes", sortable: false },
  { id: "created", kind: "created", label: "Created", sortable: true },
  { id: "edited", kind: "edited", label: "Edited", sortable: true },
];

function formatCreated(createdAt: string | null): string {
  // The user's display format (the settings dateFormat) — tables, footers,
  // and exports all ride the same helper. (Despite the name, the Edited
  // column rides it too — it formats any ISO date the same way.)
  return formatIsoDate(createdAt) ?? (createdAt === null ? "" : createdAt);
}

/**
 * The name-column text: the FULL title with inline class chips resolved to
 * their class's current name (owner 2026-10-13 — a title that opens with a
 * chip reads complete in the cell, the CSV projection, and the sort key,
 * all three riding this same text). The cell WRAPS long titles across
 * multiple lines (owner 2026-10-20), so the dense-chrome 80-char budget
 * doesn't apply — the cell reads fullTitleOf, the same uncapped derivation
 * node links render (the links' whole-title ruling). Date nodes keep the
 * settings-formatted nodeDisplayName branch: their titles are short
 * (the cap never binds) and only that branch applies the user's dateFormat.
 */
function nameCellText(client: AnyClient, node: ClientNode): string {
  const resolve = (classId: string) => client.getDisplayName(classId);
  if (parseDateNodeId(node.id) !== null) {
    return nodeDisplayName(node, resolve) || "Untitled";
  }
  return fullTitleOf(node, resolve) || "Untitled";
}

/**
 * The CSV projection of one cell — the same display text the row renders
 * (names, class labels, the locale created date, property display strings),
 * so the downloaded file is WYSIWYG against the on-screen table. Raw ids
 * never leak: the conventions above resolve targets to current names.
 */
function csvCellText(client: AnyClient, row: TableRow, column: TableColumn): string {
  const node = row.item.node;
  if (column.kind === "name") return nameCellText(client, node);
  if (column.kind === "classes") {
    return node.classIds
      .map((classId) => displayNameFromClient(client, classId))
      .filter((name): name is string => name !== null && name !== undefined)
      .join(", ");
  }
  if (column.kind === "created") return formatCreated(node.createdAt);
  if (column.kind === "edited") return formatCreated(node.updatedAt);
  if (column.kind === "isClass") return node.isClass ? "Yes" : "—";
  if (column.kind === "isEmbedded") return node.isEmbedded ? "Yes" : "—";
  const prop = row.properties.find((p) => p.propertySchemaId === column.propertySchemaId);
  return propertyDisplayText(client, prop);
}

/** Item + its resolved properties (fetched once per row for cell render). */
interface TableRow {
  item: NodeCollectionItem;
  properties: EffectiveProperty[];
}

function columnSortValue(
  client: AnyClient,
  column: TableColumn,
  row: TableRow,
): string | number | null {
  if (column.kind === "name") {
    return nameCellText(client, row.item.node);
  }
  if (column.kind === "created") {
    return row.item.node.createdAt ?? "";
  }
  if (column.kind === "edited") {
    return row.item.node.updatedAt ?? "";
  }
  if (column.kind === "isClass") {
    return row.item.node.isClass ? 1 : 0;
  }
  if (column.kind === "isEmbedded") {
    return row.item.node.isEmbedded ? 1 : 0;
  }
  if (column.kind === "classes") {
    return null; // not sortable
  }
  const schema = client.listPropertySchemas().find((s) => s.id === column.propertySchemaId);
  const prop = row.properties.find((p) => p.propertySchemaId === column.propertySchemaId);
  if (schema?.type === "number" || schema?.type === "integer") {
    return prop === undefined || isEmptyPropertyValue(prop.value) ? null : Number(prop.value);
  }
  if (schema?.type === "boolean") {
    return prop?.value === true ? 1 : 0;
  }
  return prop === undefined || isEmptyPropertyValue(prop.value)
    ? null
    : propertyDisplayText(client, prop);
}

/** Stable multi-sort: each spec compares; empty values sink last. */
function compareRows(
  client: AnyClient,
  specs: SortSpec[],
  columns: TableColumn[],
  rowA: TableRow,
  rowB: TableRow,
): number {
  for (const spec of specs) {
    const column = columns.find((c) => c.id === spec.key);
    if (column === undefined || column.sortable === false) continue;
    const valueA = columnSortValue(client, column, rowA);
    const valueB = columnSortValue(client, column, rowB);
    const emptyA = valueA === null || valueA === "";
    const emptyB = valueB === null || valueB === "";
    if (emptyA !== emptyB) return emptyA ? 1 : -1;
    if (emptyA && emptyB) continue;
    const direction = spec.direction === "asc" ? 1 : -1;
    if (typeof valueA === "number" && typeof valueB === "number") {
      if (valueA !== valueB) return (valueA - valueB) * direction;
      continue;
    }
    const compared = String(valueA).localeCompare(String(valueB), undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (compared !== 0) return compared * direction;
  }
  return 0;
}

function ClassChips({ item, props }: { item: NodeCollectionItem; props: NodeCollectionProps }) {
  const { client } = props;
  const classes = item.node.classIds
    .map((classId) => client.getNode(classId))
    .filter((node): node is ClientNode => node !== undefined);
  if (classes.length === 0) return null;
  return (
    <span className="nt-table-chips">
      {classes.map((cls) => (
        <span key={cls.id} className="nt-table-chip" style={cls.color !== null ? { color: cls.color } : undefined}>
          {labelFromClient(client, cls.id) ?? "Untitled"}
        </span>
      ))}
    </span>
  );
}

/** Click-to-edit inline input: commit on blur/Enter, cancel on Escape. The
 *  empty cell reads "Empty" (owner 2026-10-21 — the muted state placeholder
 *  idiom; the input's aria-label already names the field). */
function InlineInput({
  value,
  inputType = "text",
  ariaLabel,
  onCommit,
}: {
  value: string;
  inputType?: string;
  ariaLabel: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <input
      // Remount per value change so the draft resets between edits.
      key={value}
      type={inputType}
      className="nt-table-input"
      aria-label={ariaLabel}
      placeholder={value === "" ? "Empty" : undefined}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit(draft);
        if (event.key === "Escape") onCommit(value);
      }}
    />
  );
}

/** The cell-level write shared by the inline editors (scalar types). */
function commitCellValue(
  props: NodeCollectionProps,
  row: TableRow,
  schemaId: string,
  idx: number | undefined,
  next: unknown,
): void {
  const { client } = props;
  if (next === "" || next === null) {
    if (idx !== undefined) void client.unsetProperty(row.item.node.id, schemaId, idx);
    return;
  }
  void client.setProperty(row.item.node.id, schemaId, next, idx ?? 0);
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The carrier block a text value references ({nodeId} or legacy bare uuid). */
function carrierRefOf(value: unknown): string | null {
  if (typeof value === "object" && value !== null && "nodeId" in value) {
    const id = (value as { nodeId: unknown }).nodeId;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return typeof value === "string" && UUID_LIKE.test(value) ? value : null;
}

/**
 * Text-property cell (owner 2026-10-21) — the name cell's contract applied
 * to the value's carrier block: the cell renders the carrier through
 * BlockRow variant="title" (inline tokens render read mode, a click swaps
 * in the full block editor whose writes land on the carrier itself), so a
 * text cell reads exactly like the name cell beside it — the retired
 * bordered inline input flattened rich text to edit it. An empty (or
 * broken-ref) cell renders the muted schema-name placeholder (the NodeCell
 * precedent): one click creates the carrier, links it at the property's
 * idx, and lands straight in the editor (BlockRow autoEdit). With a
 * carrier assigned, the pinned Open button rides the cell too (owner
 * 2026-10-21 — the name cell's navigation twin): the value click owns
 * editing, the button owns navigation (click opens the carrier, shift+click
 * peeks it in the sidebar); the empty placeholder carries no button.
 *
 * Auto-unset (the TextPropertyRow contract, table-scaled): an authored
 * carrier with no content and no children unsets once the caret is no
 * longer inside it — the fresh carrier the placeholder just minted is
 * excepted by the focus guard (its autoEdit editor holds the caret), and
 * the unset trashes the orphaned carrier, so empty cells never strand dead
 * blocks. The pass rides the cell's own client subscription (the metadata
 * row's precedent — the table host is not guaranteed to re-render on a
 * store write) and runs on every synced render; the fresh reads come from
 * the client, never a stale render closure.
 */
function TextCell({
  row,
  schemaId,
  props,
  schemaName,
  peek,
}: {
  row: TableRow;
  schemaId: string;
  props: NodeCollectionProps;
  schemaName: string;
  peek: (id: string) => void;
}) {
  const { client } = props;
  const prop = row.properties.find((p) => p.propertySchemaId === schemaId);
  const ref = carrierRefOf(prop?.value);
  const carrier = ref !== null ? client.getNode(ref) : undefined;
  /** The carrier created by the placeholder click — it mounts in edit mode. */
  const [freshId, setFreshId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  // The cell stays live outside a subscribing host (the TextPropertyRow
  // precedent): writes (the editor's flush, the unset below) re-render it.
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  useEffect(() => {
    if (carrier === undefined || prop?.source !== "authored") return;
    const contentless =
      plainTextExcerpt(carrier.contentAst).trim() === "" && client.getChildren(carrier.id).length === 0;
    if (!contentless) return;
    // The just-minted carrier's editor holds the caret — the user may be
    // about to type; anything else emptied is unset now.
    if (wrapRef.current?.contains(document.activeElement) === true) return;
    void client.unsetProperty(row.item.node.id, schemaId, prop.idx);
  });

  if (carrier === undefined) {
    // The empty state says "Empty" (owner 2026-10-21); the click
    // creates-and-edits, so the accessible name names the action.
    return (
      <button
        type="button"
        className="nt-table-text-empty"
        aria-label={`Add ${schemaName}`}
        onClick={() => {
          void (async () => {
            const created = await client.createObject({
              parentId: row.item.node.id,
              contentAst: [],
            });
            await client.setProperty(row.item.node.id, schemaId, { nodeId: created }, prop?.idx ?? 0);
            setFreshId(created);
          })();
        }}
      >
        <span className="nt-table-date-placeholder">Empty</span>
      </button>
    );
  }

  const label = displayNameFromClient(client, carrier.id) ?? "carrier";
  return (
    <span className="nt-table-node">
      <span className="nt-table-text-cell" ref={wrapRef}>
        <BlockRow
          variant="title"
          tree={{ node: carrier, children: [] }}
          client={client}
          resolveName={(classId) => client.getDisplayName(classId)}
          autoEdit={carrier.id === freshId}
        />
      </span>
      <OpenButton
        label={label}
        onOpen={() => props.onNodeClick?.(carrier.id)}
        onPeek={() => peek(carrier.id)}
      />
    </span>
  );
}

/**
 * Multi-value node-typed cell (owner 2026-10-21) — the metadata ObjectPropertyRow's
 * pill cluster, table-scaled: every value rides the shared NodePill (the
 * linked node's effective color/icon, click opens, hover-reveal × unsets
 * its own idx slot; a broken ref renders the dashed raw-id honest state),
 * and the "+ Add" pill opens the anchored NodeSelector appending at the
 * next free idx. The schema's targetClassFilter scopes the search AND the
 * create row (the created node carries the filter classes). The empty cell
 * reads "Empty" like every other property cell (owner 2026-10-21) — one
 * click opens the picker; the "+ Add <name>" pill rides the VALUED cells
 * only.
 */
function MultiNodeCell({
  row,
  schemaId,
  props,
  schemaName,
}: {
  row: TableRow;
  schemaId: string;
  props: NodeCollectionProps;
  schemaName: string;
}) {
  const { client } = props;
  const [open, setOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const rows = row.properties
    .filter((p) => p.propertySchemaId === schemaId)
    .sort((a, b) => a.idx - b.idx);
  const pills = rows
    .map((p) => ({ row: p, ref: carrierRefOf(p.value) }))
    .filter((pill): pill is { row: EffectiveProperty; ref: string } => pill.ref !== null);
  const linkedIds = new Set(pills.map((pill) => pill.ref));
  const authoredIdx = rows.filter((p) => p.source === "authored").map((p) => p.idx);
  // Per-slot append (the ObjectPropertyRow pattern): the next free idx past
  // the highest authored slot.
  const nextIdx = authoredIdx.length > 0 ? Math.max(...authoredIdx) + 1 : 0;
  const targetClassIds = resolveTargetClassIds(client, schemaId, null);
  const picker = open ? (
    <NodeSelector
      client={client}
      searchMode="pages"
      classFilters={targetClassIds ?? undefined}
      excludeNodeId={row.item.node.id}
      canAdd={(node) => !linkedIds.has(node.id)}
      anchorEl={addRef.current}
      onClose={() => setOpen(false)}
      searchPlaceholder={`Search ${schemaName}`}
      onAdd={(node) => {
        setOpen(false);
        void client.setProperty(row.item.node.id, schemaId, { nodeId: node.id }, nextIdx);
      }}
    />
  ) : null;
  if (pills.length === 0) {
    // The empty cell reads "Empty" like every other property cell (owner
    // 2026-10-21 — one UI for empties): one click opens the picker; the
    // "+ Add" pill rides the VALUED cells only. The picker anchors at the
    // placeholder button.
    return (
      <>
        <button
          type="button"
          ref={addRef}
          className="nt-table-text-empty"
          aria-label={`Add ${schemaName}`}
          onClick={() => setOpen(true)}
        >
          <span className="nt-table-date-placeholder">Empty</span>
        </button>
        {picker}
      </>
    );
  }
  return (
    <span className="nt-table-chips">
      {pills.map(({ row: pillRow, ref }) => {
        const linked = client.getNode(ref);
        const label = labelFromClient(client, ref) ?? "Untitled";
        if (linked === undefined) {
          // PB1 honest state — the raw id, never a silently empty chip.
          return (
            <span key={`${schemaId}:${pillRow.idx}`} className="pill pill--broken" title={`Broken reference: ${ref}`}>
              <span className="pill__text nt-chip-label nt-chip-label--broken">
                <code>{ref}</code>
              </span>
              <button
                type="button"
                className="pill__right-button nt-chip-remove"
                aria-label={`Remove ${label}`}
                onClick={() => void client.unsetProperty(row.item.node.id, schemaId, pillRow.idx)}
              >
                <Icon path="mdi-close" size={0.6} />
              </button>
            </span>
          );
        }
        return (
          <NodePill
            key={`${schemaId}:${pillRow.idx}`}
            color={client.effectiveNodeColor(linked)}
            icon={linked.icon}
            label={label}
            onOpen={() => props.onNodeClick?.(ref)}
            onRemove={() => void client.unsetProperty(row.item.node.id, schemaId, pillRow.idx)}
            removeLabel={`Remove ${label}`}
          />
        );
      })}
      <AddPill
        ref={addRef}
        label={`Add ${schemaName}`}
        aria-expanded={open}
        onClick={(element) => {
          addRef.current = element;
          setOpen((cur) => !cur);
        }}
      />
      {picker}
    </span>
  );
}

/**
 * Asset-property cell (owner 2026-10-21) — the metadata ObjectPropertyRow's
 * asset branch, table-scaled: every value rides the shared NodePill whose
 * click DOWNLOADS the asset (the metadata pill's primary action — the
 * original filename labels the pill), with the ❝ annotations toggle opening
 * the annotations panel anchored under the cell (the node-pills overflow
 * popup pattern) and the hover-reveal × unsetting its own idx slot. The
 * empty cell reads "Empty" like every other property cell — one click opens
 * the anchored NodeSelector (searchMode "all") whose create row IS the
 * upload action — "Upload file…" opens the AssetUploadModal and the
 * uploaded asset links at the next free idx; a single-value schema replaces
 * its authored slot instead (the ObjectPropertyRow write pattern, cover
 * values included). Valued cells wear the "+ Add <name>" pill for appends.
 */
function AssetCell({
  row,
  schemaId,
  props,
  schemaName,
}: {
  row: TableRow;
  schemaId: string;
  props: NodeCollectionProps;
  schemaName: string;
}) {
  const { client } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  /** The pill whose annotations panel is open, anchored at its position. */
  const [annotating, setAnnotating] = useState<{ ref: string; top: number; left: number } | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const annotRef = useRef<HTMLDivElement | null>(null);
  usePopupDismissal({
    popupRef: annotRef,
    isOpen: annotating !== null,
    onClose: () => setAnnotating(null),
  });

  const rows = row.properties
    .filter((p) => p.propertySchemaId === schemaId)
    .sort((a, b) => a.idx - b.idx);
  const pills = rows
    .map((p) => ({ row: p, ref: carrierRefOf(p.value) }))
    .filter((pill): pill is { row: EffectiveProperty; ref: string } => pill.ref !== null);
  const authoredIdx = rows.filter((p) => p.source === "authored").map((p) => p.idx);
  const nextIdx = authoredIdx.length > 0 ? Math.max(...authoredIdx) + 1 : 0;
  const single = client.listPropertySchemas().find((s) => s.id === schemaId)?.multi === false;
  // Single-value: the pick rewrites the highest authored slot; multi:
  // appends at the next free idx.
  const writeIdx = single && authoredIdx.length > 0 ? Math.max(...authoredIdx) : nextIdx;
  const targetClassIds = resolveTargetClassIds(client, schemaId, null);
  const assetClassId = targetClassIds?.find((id) => isAssetClass(client, id));
  const isAssetTarget = assetClassId !== undefined;

  const pillLabel = (ref: string): string =>
    client.getAssetInfo(ref)?.originalName ?? labelFromClient(client, ref) ?? "Untitled";

  const linkAsset = async (assetNodeId: string, idx: number): Promise<void> => {
    await client.setProperty(row.item.node.id, schemaId, { nodeId: assetNodeId }, idx);
    // A cover value written through the generic panel still classes the
    // target as an asset (the ObjectPropertyRow precedent).
    if (schemaId === SYSTEM_PROPERTY_UUIDS.cover) {
      const classIds = client.getNode(assetNodeId)?.classIds ?? [];
      if (!classIds.includes(SYSTEM_CLASS_UUIDS.asset)) {
        await client.assignClass(assetNodeId, SYSTEM_CLASS_UUIDS.asset);
      }
    }
    setUploadOpen(false);
    setPickerOpen(false);
  };

  const download = (ref: string): void => {
    const info = client.getAssetInfo(ref);
    if (info !== undefined) void client.downloadAsset(info.assetId);
  };

  const picker = pickerOpen ? (
    <NodeSelector
      client={client}
      searchMode="all"
      classFilters={targetClassIds ?? undefined}
      excludeNodeId={row.item.node.id}
      anchorEl={addRef.current}
      onClose={() => setPickerOpen(false)}
      searchPlaceholder={`Search ${schemaName}`}
      onAdd={(node) => {
        setPickerOpen(false);
        void linkAsset(node.id, writeIdx);
      }}
      // Asset targets: the create row IS the upload action (the
      // ObjectPropertyRow precedent) — "Upload file…" opens the modal,
      // never a bare create. Unresolvable filter: plain create.
      alwaysShowCreate={isAssetTarget}
      createLabel={isAssetTarget ? "Upload file…" : undefined}
      onCreateNew={
        isAssetTarget
          ? () => {
              setPickerOpen(false);
              setUploadOpen(true);
            }
          : (name) =>
              client.createObject({
                isEmbedded: false,
                name,
                ...(targetClassIds !== null ? { classIds: targetClassIds } : {}),
              })
      }
    />
  ) : null;

  if (pills.length === 0) {
    // The empty cell reads "Empty" like every other property cell (owner
    // 2026-10-21 — one UI for empties): one click opens the picker (whose
    // create row is the upload action); the "+ Add" pill rides the VALUED
    // cells only.
    return (
      <>
        <button
          type="button"
          ref={addRef}
          className="nt-table-text-empty"
          aria-label={`Add ${schemaName}`}
          onClick={() => setPickerOpen(true)}
        >
          <span className="nt-table-date-placeholder">Empty</span>
        </button>
        {picker}
        {uploadOpen && assetClassId !== undefined && (
          <AssetUploadModal
            isOpen
            client={client}
            assetClassId={assetClassId}
            onClose={() => setUploadOpen(false)}
            onUploaded={(assetNodeId) => void linkAsset(assetNodeId, writeIdx)}
          />
        )}
      </>
    );
  }

  return (
    <span className="nt-table-chips">
      {pills.map(({ row: pillRow, ref }) => {
        const linked = client.getNode(ref);
        const label = pillLabel(ref);
        if (linked === undefined) {
          return (
            <span key={`${schemaId}:${pillRow.idx}`} className="pill pill--broken" title={`Broken reference: ${ref}`}>
              <span className="pill__text nt-chip-label nt-chip-label--broken">
                <code>{ref}</code>
              </span>
              <button
                type="button"
                className="pill__right-button nt-chip-remove"
                aria-label={`Remove ${label}`}
                onClick={() => void client.unsetProperty(row.item.node.id, schemaId, pillRow.idx)}
              >
                <Icon path="mdi-close" size={0.6} />
              </button>
            </span>
          );
        }
        return (
          <NodePill
            key={`${schemaId}:${pillRow.idx}`}
            color={client.effectiveNodeColor(linked)}
            icon={linked.icon}
            label={label}
            onOpen={() => download(ref)}
            onRemove={() => void client.unsetProperty(row.item.node.id, schemaId, pillRow.idx)}
            removeLabel={`Remove ${label}`}
            trailing={
              // The ❝ annotations toggle — an asset-pill primary action,
              // never hidden (the metadata row's contract).
              <button
                type="button"
                className="pill__right-button nt-chip-annotations"
                title="Annotations"
                aria-label={`Annotate ${label}`}
                aria-expanded={annotating?.ref === ref}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setAnnotating((cur) =>
                    cur?.ref === ref ? null : { ref, top: rect.bottom + 4, left: rect.left },
                  );
                }}
              >
                ❝
              </button>
            }
          />
        );
      })}
      <AddPill
        ref={addRef}
        label={`Add ${schemaName}`}
        aria-expanded={pickerOpen}
        onClick={(element) => {
          addRef.current = element;
          setPickerOpen((cur) => !cur);
        }}
      />
      {picker}
      {uploadOpen && assetClassId !== undefined && (
        <AssetUploadModal
          isOpen
          client={client}
          assetClassId={assetClassId}
          onClose={() => setUploadOpen(false)}
          onUploaded={(assetNodeId) => void linkAsset(assetNodeId, writeIdx)}
        />
      )}
      {annotating !== null && (
        <>
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop closes on click */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: "var(--z-9998)" }}
            onClick={() => setAnnotating(null)}
          />
          {createPortal(
            <div
              ref={annotRef}
              className="nt-table-annot-popup"
              role="dialog"
              aria-label={`Annotations for ${pillLabel(annotating.ref)}`}
              style={{ position: "fixed", top: annotating.top, left: annotating.left, zIndex: "var(--z-9999)" }}
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <AnnotationsSection
                client={client}
                assetId={annotating.ref}
                onOpenPage={(id) => {
                  setAnnotating(null);
                  props.onNodeClick?.(id);
                }}
              />
            </div>,
            document.body,
          )}
        </>
      )}
    </span>
  );
}

/**
 * The datetime cell (SCHEMA.md "Datetime" — the unified date type): reads
 * the value union (a point or a range), renders it through the slot
 * formatter, and edits through the canonical date-picker popup — the
 * suggestions column, the All-day/Range switches, and Remove all commit the
 * full union through one write. The open-arrow jumps to the day page
 * ("create the day page" — the chain ensure is an idempotent no-op when it
 * exists).
 */
function DateCell({ row, schemaId, props, schemaName, peek }: { row: TableRow; schemaId: string; props: NodeCollectionProps; schemaName: string; peek: (id: string) => void }) {
  const { client } = props;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const prop = row.properties.find((p) => p.propertySchemaId === schemaId);
  const value = prop?.value;
  const precision =
    client.listPropertySchemas().find((s) => s.id === schemaId)?.datePrecision ?? "day";

  /** One stored slot of the value as the popup edits it (iso + optional time). */
  const slotOf = (v: unknown): DatetimePickerSlot | null => {
    if (typeof v !== "object" || v === null) return null;
    const ref = (v as { nodeId?: unknown }).nodeId;
    if (typeof ref !== "string") return null;
    const iso = isoOfRef(ref);
    if (iso === null) return null;
    const time = (v as { time?: unknown }).time;
    return isValidTimeOfDay(time) ? { iso, time } : { iso };
  };

  const isRange = isRangeDatetimeValue(value);
  const start = isRange ? slotOf((value as { start?: unknown }).start) : slotOf(value);
  const end = isRange ? slotOf((value as { end?: unknown }).end) : null;
  const display = datetimeValueText(value) ?? propertyDisplayText(client, prop);
  return (
    <span className="nt-table-node">
      <button
        type="button"
        ref={anchorRef}
        className="nt-dateslot__button"
        aria-label={schemaName}
        aria-expanded={open}
        onClick={() => setOpen((cur) => !cur)}
      >
        {/* The empty cell reads "Empty" (owner 2026-10-21 — the muted
            state placeholder; the accessible name names the action). An
            empty button collapsed to zero height and was near-unclickable
            (owner 2026-10-20). */}
        {display === "" ? <span className="nt-table-date-placeholder">Empty</span> : display}
      </button>
      {open && (
        <DatePickerPopup
          value={{ isRange, start, end }}
          precision={precision}
          onCommit={(commit) => {
            // The popup owns its closing (terminal commits close through
            // onClose); the write rides the full union either way.
            void client.setDatetimeProperty(row.item.node.id, schemaId, commit, prop?.idx ?? 0);
          }}
          onRemove={
            prop !== undefined
              ? () => {
                  void commitCellValue(props, row, schemaId, prop.idx, null);
                  setOpen(false);
                }
              : undefined
          }
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
          firstDayOfWeek={1}
          markedDates={collectMarkedDates(client)}
        />
      )}
      {start !== null && (
        <OpenButton
          label={`the ${start.iso} day page`}
          onOpen={() => {
            void client.ensureDateChain(start.iso).then(({ day }) => props.onNodeClick?.(day));
          }}
          onPeek={() => {
            void client.ensureDateChain(start.iso).then(({ day }) => peek(day));
          }}
        />
      )}
    </span>
  );
}

/** A date ref back to a full ISO date at its own precision. */
function isoOfRef(ref: string): string | null {
  const parsed = parseDateNodeId(ref);
  if (parsed === null) return null;
  return `${String(parsed.year).padStart(4, "0")}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
}

/** The datetime value's navigation target: the START slot's node id (a
    range's day-page jump rides its start, the DateCell precedent). */
function datetimeStartRef(value: unknown): string | null {
  const refOf = (slot: unknown): string | null =>
    typeof slot === "object" &&
    slot !== null &&
    "nodeId" in slot &&
    typeof (slot as { nodeId: unknown }).nodeId === "string"
      ? (slot as { nodeId: string }).nodeId
      : null;
  if (isRangeDatetimeValue(value)) return refOf((value as { start?: unknown }).start);
  return refOf(value);
}

/**
 * The row's Open button — the table's navigate affordance (owner
 * 2026-10-20): the same ghost/sm/arrow-right button as the workspace
 * card's "Open workspace" action, pinned to the cell's right edge
 * regardless of the text content. Serves the name cell and the
 * single-value node/date property cells alike (the value click owns the
 * picker; the button owns navigation). Click opens; shift+click peeks
 * in the sidebar card.
 */
function OpenButton({
  label,
  onOpen,
  onPeek,
}: {
  label: string;
  onOpen: () => void;
  onPeek: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      icon="mdi mdi-arrow-right"
      className="nt-table-open-btn"
      title={`Open ${label}`}
      aria-label={`Open ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        if (event.shiftKey) onPeek();
        else onOpen();
      }}
    />
  );
}

/** Name cell (owner 2026-10-21): the node's title as a block row — the page
 * header's title projection (variant="title"): inline tokens render read
 * mode (markdown links as links, class chips resolved — never the raw-source
 * flatten), a click inside the cell swaps in the full block editor (the
 * title variant's relaxed contract — Enter flushes and leaves edit, no
 * split/structural gestures), and the pinned Open button owns navigation
 * (click opens, shift+click peeks). The retired single-text-token rename
 * input flattened rich titles to edit them — the real editor needs no such
 * guard, so the simple/rich distinction retires with it. */
function NameCell({
  node,
  icon,
  props,
  onPeek,
}: {
  node: ClientNode;
  icon: string | null;
  props: NodeCollectionProps;
  /** The peek target — the container's onNodeShiftClick or the enclosing
      context's openInSidebar fallback (TableView computes it). */
  onPeek: (id: string) => void;
}) {
  const { client } = props;
  const label = nameCellText(client, node);
  return (
    <span className="nt-table-name-row">
      {icon !== null && <Icon path={icon} size={0.9} className="nt-table-name-icon" />}
      <BlockRow
        variant="title"
        tree={{ node, children: [] }}
        client={client}
        resolveName={(classId) => client.getDisplayName(classId)}
      />
      <OpenButton
        label={label}
        onOpen={() => props.onNodeClick?.(node.id)}
        onPeek={() => onPeek(node.id)}
      />
    </span>
  );
}

function NodeCell({ row, schemaId, props, schemaName, peek }: { row: TableRow; schemaId: string; props: NodeCollectionProps; schemaName: string; peek: (id: string) => void }) {
  const prop = row.properties.find((p) => p.propertySchemaId === schemaId);
  const target = prop?.value as { nodeId?: unknown } | undefined;
  const targetId = typeof target?.nodeId === "string" ? target.nodeId : null;
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <span className="nt-table-node">
      <button
        type="button"
        ref={anchorRef}
        className="nt-table-date"
        // The empty cell reads "Empty" (owner 2026-10-21, the muted state
        // placeholder idiom); the accessible name names the action.
        aria-label={targetId !== null ? undefined : `Add ${schemaName}`}
        onClick={() => setOpen(true)}
      >
        {targetId !== null ? (
          labelFromClient(props.client, targetId) ?? "Untitled"
        ) : (
          <span className="nt-table-date-placeholder">Empty</span>
        )}
      </button>
      {targetId !== null && (
        <OpenButton
          label={displayNameFromClient(props.client, targetId) ?? "target"}
          onOpen={() => props.onNodeClick?.(targetId)}
          onPeek={() => peek(targetId)}
        />
      )}
      {open && (
        <NodeSelector
          client={props.client}
          anchorEl={anchorRef.current}
          onClose={() => setOpen(false)}
          onAdd={(node) => {
            setOpen(false);
            commitCellValue(props, row, schemaId, prop?.idx, { nodeId: node.id });
          }}
        />
      )}
    </span>
  );
}

function PropertyCell({ row, column, props, peek }: { row: TableRow; column: TableColumn; props: NodeCollectionProps; peek: (id: string) => void }) {
  const { client, tableEditable = false } = props;
  const schemaId = column.propertySchemaId!;
  const schema = client.listPropertySchemas().find((s) => s.id === schemaId);
  const prop = row.properties.find((p) => p.propertySchemaId === schemaId);
  // Readonly-ness derives from the system property list (owner ruling
  // 2026-10-21 — the render contract retired from the wire/store).
  const editable = tableEditable && !isReadonlyProperty(schemaId);

  if (editable && schema?.type === "boolean") {
    return (
      <BooleanToggle
        size="sm"
        checked={prop?.value === true}
        onChange={(checked) => {
          void client.setProperty(row.item.node.id, schemaId, checked, prop?.idx ?? 0);
        }}
        aria-label={schema.name}
      />
    );
  }

  if (editable && schema?.type === "select" && schema.options !== null && schema.options.length > 0 && !schema.multi) {
    const value = typeof prop?.value === "string" ? prop.value : "";
    return (
      <select
        className="nt-table-select"
        aria-label={schema.name}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "") commitCellValue(props, row, schemaId, prop?.idx, null);
          else commitCellValue(props, row, schemaId, prop?.idx, next);
        }}
      >
        <option value="">—</option>
        {schema.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (editable && (schema?.type === "text" || schema?.type === "url" || schema?.type === "email") && schema?.multi !== true) {
    if (schema?.type === "text") {
      return <TextCell row={row} schemaId={schemaId} props={props} schemaName={schema.name} peek={peek} />;
    }
    return (
      <InlineInput
        value={propertyDisplayText(client, prop)}
        ariaLabel={schema.name}
        onCommit={(next) => commitCellValue(props, row, schemaId, prop?.idx, next)}
      />
    );
  }

  if (editable && (schema?.type === "number" || schema?.type === "integer") && schema?.multi !== true) {
    return (
      <InlineInput
        value={propertyDisplayText(client, prop)}
        inputType="number"
        ariaLabel={schema.name}
        onCommit={(next) =>
          commitCellValue(props, row, schemaId, prop?.idx, next === "" ? "" : Number(next))
        }
      />
    );
  }

  if (editable && schema?.type === "datetime" && schema?.multi !== true) {
    return <DateCell row={row} schemaId={schemaId} props={props} schemaName={schema.name} peek={peek} />;
  }

  if (editable && schema?.type === "object" && schema?.multi === true) {
    return <MultiNodeCell row={row} schemaId={schemaId} props={props} schemaName={schema.name} />;
  }

  if (editable && schema?.type === "object" && schema?.multi !== true) {
    return <NodeCell row={row} schemaId={schemaId} props={props} schemaName={schema.name} peek={peek} />;
  }

  if (editable && schema?.type === "asset") {
    return <AssetCell row={row} schemaId={schemaId} props={props} schemaName={schema.name} />;
  }

  // Url/email values render as links (mailto: for email; a url
  // value keeps whatever scheme the author wrote, tel: included).
  const href = propertyLinkHref(schema?.type, prop?.value);
  if (href !== null) {
    return (
      <a className="nt-table-link" href={href} target="_blank" rel="noreferrer">
        {propertyDisplayText(client, prop)}
      </a>
    );
  }

  // Read-only node/date cells: no picker on click (the editable branch owns
  // the picker), but the navigate button still applies — owner 2026-10-20:
  // navigation rides the pinned button everywhere these cells render.
  if (prop !== undefined && schema?.multi !== true) {
    if (schema?.type === "object") {
      const ref = carrierRefOf(prop.value);
      if (ref !== null) {
        return (
          <span className="nt-table-node">
            {propertyDisplayText(client, prop)}
            <OpenButton
              label={displayNameFromClient(client, ref) ?? "target"}
              onOpen={() => props.onNodeClick?.(ref)}
              onPeek={() => peek(ref)}
            />
          </span>
        );
      }
    }
    if (schema?.type === "datetime") {
      const ref = datetimeStartRef(prop.value);
      if (ref !== null) {
        const iso = isoOfRef(ref);
        const open = () => {
          if (iso !== null) {
            void client.ensureDateChain(iso).then(({ day }) => props.onNodeClick?.(day));
          } else {
            props.onNodeClick?.(ref);
          }
        };
        const peekTarget = () => {
          if (iso !== null) {
            void client.ensureDateChain(iso).then(({ day }) => peek(day));
          } else {
            peek(ref);
          }
        };
        return (
          <span className="nt-table-node">
            {propertyDisplayText(client, prop)}
            <OpenButton
              label={iso !== null ? `the ${iso} day page` : "target"}
              onOpen={open}
              onPeek={peekTarget}
            />
          </span>
        );
      }
    }
  }

  // Read-only projection: EVERY value of the schema renders (multi rows
  // join), never just the first.
  const tailText = row.properties
    .filter((p) => p.propertySchemaId === schemaId)
    .map((p) => propertyDisplayText(client, p))
    .filter((text) => text !== "")
    .join(", ");
  if (
    tailText === "" &&
    schema?.multi !== true &&
    (schema?.type === "object" || schema?.type === "datetime")
  ) {
    return <span className="nt-table-date-placeholder">{schema?.name ?? ""}</span>;
  }

  return <>{tailText}</>;
}

/** The multi-sort panel: ordered entries, add/remove, direction, priority. */
function SortPanel({
  sort,
  onChange,
  columns,
}: {
  sort: SortSpec[];
  onChange: (sort: SortSpec[]) => void;
  columns: TableColumn[];
}) {
  const sortable = columns.filter((c) => c.sortable !== false);
  const unused = sortable.filter((c) => !sort.some((s) => s.key === c.id));
  return (
    <div className="nt-table-panel">
      <div className="nt-table-panel__title">Sort by</div>
      {sort.length === 0 && <div className="nt-table-panel__hint">No sort — click a column header for a quick sort.</div>}
      {sort.map((spec, index) => (
        <div className="nt-table-panel__row" key={spec.key}>
          <span className="nt-table-panel__label">{columns.find((c) => c.id === spec.key)?.label ?? spec.key}</span>
          <button
            type="button"
            className="nt-table-panel__action"
            aria-label={`${columns.find((c) => c.id === spec.key)?.label ?? spec.key}: ${spec.direction === "asc" ? "ascending" : "descending"} — toggle`}
            onClick={() =>
              onChange(
                sort.map((s) =>
                  s.key === spec.key ? { ...s, direction: s.direction === "asc" ? "desc" : "asc" } : s,
                ),
              )
            }
          >
            {spec.direction === "asc" ? "↑" : "↓"}
          </button>
          <button
            type="button"
            className="nt-table-panel__action"
            aria-label="Move up"
            disabled={index === 0}
            onClick={() => {
              const next = [...sort];
              [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
              onChange(next);
            }}
          >
            ⌃
          </button>
          <button
            type="button"
            className="nt-table-panel__action"
            aria-label="Move down"
            disabled={index === sort.length - 1}
            onClick={() => {
              const next = [...sort];
              [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
              onChange(next);
            }}
          >
            ⌄
          </button>
          <button
            type="button"
            className="nt-table-panel__action"
            aria-label={`Remove ${columns.find((c) => c.id === spec.key)?.label ?? spec.key} sort`}
            onClick={() => onChange(sort.filter((s) => s.key !== spec.key))}
          >
            <Icon path="mdi-close" size={0.7} />
          </button>
        </div>
      ))}
      {unused.length > 0 && (
        <div className="nt-table-panel__add">
          {unused.map((column) => (
            <button
              key={column.id}
              type="button"
              className="nt-table-panel__add-item"
              onClick={() => onChange([...sort, { key: column.id, direction: "asc" }])}
            >
              + {column.label}
            </button>
          ))}
        </div>
      )}
      {sort.length > 0 && (
        <button type="button" className="nt-table-panel__reset" onClick={() => onChange([])}>
          Reset
        </button>
      )}
    </div>
  );
}

/** The column selector lives inline in the toolbar's ButtonWithPanel. */

export function TableView(props: NodeCollectionProps) {
  const { client, items = [], tableColumns, propertiesOf, onNodeClick, onNodeShiftClick, defaultSort } = props;
  const columns = tableColumns ?? DEFAULT_COLUMNS;
  /**
   * The peek fallback (CardsView's openInSidebar precedent): a container
   * that doesn't pass onNodeShiftClick (the class page's Classed nodes
   * section, query blocks) still peeks into the right-sidebar cards when the
   * table rides inside a page's OutlinerContext; the shell hubs pass the
   * prop explicitly and never reach the fallback.
   */
  const outer = useContext(OutlinerContext);
  const peekNode = (id: string) => (onNodeShiftClick ?? outer?.openInSidebar)?.(id);
  // Hosted collections: the toolbar portals into the tab bar's right-hand
  // cluster (owner 2026-10-12); un-hosted it rides the body top.
  const chromeTarget = useViewChromeTarget();
  /**
   * The sort state — session-local, but the container's `defaultSort` stays
   * LIVE: when it CHANGES and the user has not picked a sort yet, the state
   * re-derives from the new default (the useWindowed resetKey precedent).
   * The ranked quick search rides this (owner 2026-10-13): while the search
   * ranks the pool the section drops its default to "no sort" so the ranked
   * order shows; the moment the user picks a sort (any Sort panel or header
   * change) `chosen` latches and the choice survives default flips.
   */
  const defaultSortKey = JSON.stringify(defaultSort ?? null);
  const [sortState, setSortState] = useState<{
    key: string;
    specs: SortSpec[];
    chosen: boolean;
  }>({
    key: defaultSortKey,
    specs: defaultSort !== undefined ? [defaultSort] : [],
    chosen: false,
  });
  if (sortState.key !== defaultSortKey && !sortState.chosen) {
    setSortState({
      key: defaultSortKey,
      specs: defaultSort !== undefined ? [defaultSort] : [],
      chosen: false,
    });
  }
  const sort = sortState.specs;
  const setSort = (specs: SortSpec[]) => setSortState({ key: defaultSortKey, specs, chosen: true });
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(new Set());
  const [extraColumns, setExtraColumns] = useState<ReadonlySet<string>>(new Set());
  /**
   * Column resize (owner 2026-10-21): user-committed px widths, keyed by
   * column id (stable across hide/show — hidden columns keep their width).
   * Absent id = the default share rides. Session-local like the sort and
   * the column visibility.
   */
  const [colWidths, setColWidths] = useState<ReadonlyMap<string, number>>(new Map());
  const [resizing, setResizing] = useState<string | null>(null);
  const resizeDrag = useRef<{
    columnId: string;
    startX: number;
    startWidth: number;
    /** The column's default share in px — the drag floor. */
    minWidth: number;
  } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [exportSelection, setExportSelection] = useState<string[] | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const selectable = props.selectable ?? true;

  const rows = useMemo<TableRow[]>(
    () => items.map((item) => ({ item, properties: propertiesOf?.(item.node.id) ?? [] })),
    [items, propertiesOf],
  );

  /** Property columns available beyond the defaults (schema registry order). */
  const extraPool = useMemo(() => {
    const present = new Set(columns.map((c) => c.id));
    return client
      .listPropertySchemas()
      .filter((s) => !present.has(s.id))
      .map((s) => ({ id: s.id, name: s.name }));
  }, [client, columns]);

  /** The workspace property columns the user added via the Columns panel. */
  const builtExtraColumns = useMemo<TableColumn[]>(
    () =>
      [...extraColumns]
        .map((id) => extraPool.find((s) => s.id === id))
        .filter((s): s is { id: string; name: string } => s !== undefined)
        .map((s) => ({ id: s.id, kind: "property" as const, label: s.name, propertySchemaId: s.id, sortable: true })),
    [extraColumns, extraPool],
  );

  const visibleColumns = useMemo(() => {
    const base = columns.filter((c) => c.kind === "name" || !hiddenColumns.has(c.id));
    return [...base, ...builtExtraColumns];
  }, [columns, hiddenColumns, builtExtraColumns]);

  /**
   * Sort resolution reads EVERY column — hidden included — so a sort
   * survives its column being hidden (the Edited default after the user
   * hides the column, a multi-sort's lower criterion, …); the Sort panel
   * offers the same full set, so a hidden column can rejoin the sort.
   */
  const allColumns = useMemo(() => [...columns, ...builtExtraColumns], [columns, builtExtraColumns]);

  const sorted = useMemo(() => {
    if (sort.length === 0) return rows;
    return [...rows].sort((rowA, rowB) => compareRows(client, sort, allColumns, rowA, rowB));
  }, [rows, sort, client, allColumns]);

  // The display window over the FULL sorted set — every sort change
  // resets it (a resort re-narrows instead of inheriting a grown window).
  // The CSV export below reads `sorted`, never the window. Containers that
  // own their own pagination (query results) opt out via `windowed={false}`.
  const sortKey = JSON.stringify(sort);
  const { visible, remaining, showMore } = useWindowed(sorted, {
    size: ROW_WINDOW,
    resetKey: sortKey,
    enabled: props.windowed ?? true,
  });
  const iconMap = client.effectiveClassIcons();

  /**
   * The name cells render editable title BlockRows (owner 2026-10-21 — a
   * cell IS the node's title block), and BlockRow consumes an
   * OutlinerContext — so the table hosts its OWN (the FlatCards precedent,
   * visible[0]'s node as the root id; the title projection renders no
   * children and reads no tree facts): the container's onNodeClick is the
   * navigation seam, the enclosing page/class view the fallback, the shell
   * hubs' context-free render included.
   */
  const outliner = useOutlinerValue(client, visible[0]?.item.node.id ?? "", {
    openNode: (id) => (onNodeClick ?? outer?.openNode ?? (() => {}))(id),
    openInSidebar: (id) => peekNode(id),
  });

  const cycleSort = (column: TableColumn) => {
    if (column.sortable === false) return;
    const existing = sort.find((s) => s.key === column.id);
    if (existing === undefined) setSort([{ key: column.id, direction: "asc" }]);
    else if (existing.direction === "asc") setSort([{ key: column.id, direction: "desc" }]);
    else setSort([]);
  };

  const toggleHidden = (id: string) =>
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleExtra = (id: string) =>
    setExtraColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * Column resize drag: pointerdown on a header divider claims the pointer
   * (capture keeps the moves even past the cell edge); the width commits
   * LIVE on every move, clamped to the column's default share (the
   * default IS the minimum — it widens from there, never narrows below);
   * pointerup (or cancel) ends the session.
   */
  const beginColumnResize = (event: ReactPointerEvent<HTMLSpanElement>, column: TableColumn) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const th = event.currentTarget.closest("th");
    resizeDrag.current = {
      columnId: column.id,
      startX: event.clientX,
      startWidth: th?.getBoundingClientRect().width ?? 0,
      minWidth: columnMinimumWidth(column, tableRef.current),
    };
    setResizing(column.id);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveColumnResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = resizeDrag.current;
    if (drag === null) return;
    const width = Math.max(drag.minWidth, Math.round(drag.startWidth + event.clientX - drag.startX));
    setColWidths((prev) => {
      if (prev.get(drag.columnId) === width) return prev;
      const next = new Map(prev);
      next.set(drag.columnId, width);
      return next;
    });
  };
  const endColumnResize = () => {
    resizeDrag.current = null;
    setResizing(null);
  };
  /** Keyboard resize: the divider is a focusable separator; arrows nudge. */
  const nudgeColumnWidth = (column: TableColumn, delta: number) => {
    setColWidths((prev) => {
      const th = tableRef.current?.querySelector(`th[data-column-id="${column.id}"]`);
      const current = prev.get(column.id) ?? th?.getBoundingClientRect().width ?? 0;
      const next = new Map(prev);
      next.set(column.id, Math.max(columnMinimumWidth(column, tableRef.current), Math.round(current + delta)));
      return next;
    });
  };
  const allVisibleSelected = visible.length > 0 && visible.every((row) => selected.has(row.item.node.id));
  const someVisibleSelected = visible.some((row) => selected.has(row.item.node.id));

  /**
   * "Export CSV" — the current view: visible columns × the FULL sorted
   * result set (the row window is a display convenience, never an export
   * cut). The package serializer owns quoting/escaping + the UTF-8 BOM;
   * the Blob is typed text/csv so the download carries the encoding.
   * `rows` scopes the export: the whole sorted set, or — from the
   * selection chrome — exactly the checked rows.
   */
  const handleExportCsv = (rows: readonly TableRow[], stem: string) => {
    const csv = renderCsv(
      visibleColumns.map((column) => column.label),
      rows.map((row) => visibleColumns.map((column) => csvCellText(client, row, column))),
    );
    const safeStem = stem.replace(/[\\/:*?"<>|]/g, "-");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, `${safeStem}-${exportTimestamp()}.csv`);
  };

  /**
   * "Export Excel" (issue #9) — the same view cut as the CSV export, as a
   * minimal .xlsx with a LEADING uuid column ("uuid") then the visible
   * labels, so the sheet round-trips through "Import table…" (uuid rows
   * update). Number/integer columns emit typed numeric cells where the
   * display text parses unambiguously; everything else stays display text.
   */
  const xlsxCellValue = (row: TableRow, column: TableColumn): XlsxCell => {
    if (column.kind === "property") {
      const schema = client.listPropertySchemas().find((s) => s.id === column.propertySchemaId);
      if (schema?.type === "number" || schema?.type === "integer") {
        const text = csvCellText(client, row, column).trim();
        if (text === "") return null;
        const value = Number(text);
        return Number.isFinite(value) ? value : text;
      }
    }
    return csvCellText(client, row, column);
  };

  const handleExportExcel = (rows: readonly TableRow[], stem: string) => {
    const bytes = renderXlsx(
      ["uuid", ...visibleColumns.map((column) => column.label)],
      rows.map((row) => [
        row.item.node.id,
        ...visibleColumns.map((column) => xlsxCellValue(row, column)),
      ]),
    );
    // Copy into a fresh ArrayBuffer-backed array: fflate types its result as
    // Uint8Array<ArrayBufferLike>, which Blob's constructor rejects.
    const blob = new Blob([new Uint8Array(bytes)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    downloadBlob(blob, `${stem.replace(/[\\/:*?"<>|]/g, "-")}-${exportTimestamp()}.xlsx`);
  };
  const baseStem = (props.exportFileName ?? "table-export").replace(/[\\/:*?"<>|]/g, "-");
  const selectedRows = sorted.filter((row) => selected.has(row.item.node.id));
  const [importOpen, setImportOpen] = useState(false);
  const tableEditable = props.tableEditable ?? false;

  if (items.length === 0) return null;

  const renderCell = (row: TableRow, column: TableColumn): ReactNode => {
    const node = row.item.node;
    if (column.kind === "name") {
      const icon = nodeIcon(node, iconMap);
      return (
        <td key={column.id} className="nt-table-name">
          <NameCell node={node} icon={icon} props={props} onPeek={peekNode} />
        </td>
      );
    }
    if (column.kind === "classes") {
      return (
        <td key={column.id}>
          <ClassChips item={row.item} props={props} />
        </td>
      );
    }
    if (column.kind === "created") {
      const createdIso = formatIsoDate(node.createdAt);
      // Owner 2026-10-21: the date TEXT never navigates — it reads. The
      // retired click-to-navigate day link gives way to the pinned Open
      // button (the date-property-cell contract): the button owns the
      // day-page jump, hover-revealed like the name cell.
      return (
        <td key={column.id} className="nt-table-created">
          {createdIso === null ? (
            "—"
          ) : (
            <span className="nt-table-node">
              <span className="nt-table-stamp">{createdIso}</span>
              <OpenButton
                label={`the ${createdIso} day page`}
                onOpen={() => {
                  void client.ensureDateChain(createdIso).then(({ day }) => onNodeClick?.(day));
                }}
                onPeek={() => {
                  void client.ensureDateChain(createdIso).then(({ day }) => peekNode(day));
                }}
              />
            </span>
          )}
        </td>
      );
    }
    if (column.kind === "edited") {
      // The same contract as Created (owner 2026-10-21): plain text + the
      // pinned day-page Open button — no click-to-navigate anywhere on a
      // date.
      const editedIso = formatIsoDate(node.updatedAt);
      return (
        <td key={column.id} className="nt-table-created">
          {editedIso === null || node.updatedAt === null ? (
            "—"
          ) : (
            <span className="nt-table-node">
              <span className="nt-table-stamp">{formatCreated(node.updatedAt)}</span>
              <OpenButton
                label={`the ${editedIso} day page`}
                onOpen={() => {
                  void client.ensureDateChain(editedIso).then(({ day }) => onNodeClick?.(day));
                }}
                onPeek={() => {
                  void client.ensureDateChain(editedIso).then(({ day }) => peekNode(day));
                }}
              />
            </span>
          )}
        </td>
      );
    }
    if (column.kind === "isClass") {
      return (
        <td key={column.id} className="nt-table-node-type">
          {node.isClass ? "Yes" : "—"}
        </td>
      );
    }
    if (column.kind === "isEmbedded") {
      return (
        <td key={column.id} className="nt-table-node-type">
          {node.isEmbedded ? "Yes" : "—"}
        </td>
      );
    }
    return (
      <td key={column.id}>
        <PropertyCell row={row} column={column} props={props} peek={peekNode} />
      </td>
    );
  };

  const toolbar = (
    <div className="nt-table-toolbar">
        {selected.size > 0 && (
          <span className="nt-table-selection">
            <span className="nt-table-selection__count">{selected.size} selected</span>
            <Button
              variant="ghost"
              size="sm"
              icon="mdi mdi-export"
              onClick={() => setExportSelection([...selected])}
            >
              Export selected…
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon="mdi mdi-file-delimited-outline"
              aria-label="Export selected as CSV"
              title="Download the selected rows as CSV"
              onClick={() => handleExportCsv(selectedRows, `${baseStem}-selected`)}
            >
              Export selected CSV
            </Button>
          </span>
        )}
        <ButtonWithPanel
          icon="mdi-view-column"
          variant="ghost"
          size="sm"
          panelPosition="bottom"
          panelAlignment="end"
          tooltip="Columns"
          aria-label="Column selector"
        >
          {() => (
            <div className="nt-table-panel">
              <div className="nt-table-panel__title">Columns</div>
              {columns
                .filter((c) => c.kind === "classes" || c.kind === "created" || c.kind === "edited" || c.kind === "isClass" || c.kind === "isEmbedded")
                .map((column) => (
                  <label className="nt-table-panel__check" key={column.id}>
                    <Checkbox size="sm" checked={!hiddenColumns.has(column.id)} onChange={() => toggleHidden(column.id)} />
                    {column.label}
                  </label>
                ))}
              {extraPool.length > 0 && <div className="nt-table-panel__title">Properties</div>}
              {extraPool.map((schema) => (
                <label className="nt-table-panel__check" key={schema.id}>
                  <Checkbox size="sm" checked={extraColumns.has(schema.id)} onChange={() => toggleExtra(schema.id)} />
                  {schema.name}
                </label>
              ))}
            </div>
          )}
        </ButtonWithPanel>
        <ButtonWithPanel
          icon="mdi-sort"
          variant="ghost"
          size="sm"
          panelPosition="bottom"
          panelAlignment="end"
          tooltip="Sort"
          aria-label="Sort configurator"
        >
          {() => <SortPanel sort={sort} onChange={setSort} columns={allColumns} />}
        </ButtonWithPanel>
        {/* The "…" menu — the table's data actions (export/import) live
            here at the far right of the view-type toolbar, next to the
            Columns/Sort configurators. */}
        <Button
          ref={moreButtonRef}
          variant="ghost"
          size="sm"
          icon="mdi mdi-dots-vertical"
          aria-label="More table actions"
          title="More actions"
          aria-haspopup="menu"
          aria-expanded={moreMenuOpen}
          active={moreMenuOpen}
          onClick={() => setMoreMenuOpen(true)}
        />
        {moreMenuOpen && (
          <ContextMenu
            anchorEl={moreButtonRef.current}
            alignRight
            onClose={() => setMoreMenuOpen(false)}
            items={[
              {
                id: "export-csv",
                label: "Export CSV",
                icon: "mdi-file-delimited-outline",
                onClick: () => handleExportCsv(sorted, baseStem),
              },
              {
                id: "export-excel",
                label: "Export Excel",
                icon: "mdi-microsoft-excel",
                onClick: () => handleExportExcel(sorted, baseStem),
              },
              ...(tableEditable
                ? [
                    {
                      id: "import-table",
                      label: "Import table…",
                      icon: "mdi-table-arrow-down",
                      onClick: () => setImportOpen(true),
                    },
                  ]
                : []),
            ]}
          />
        )}
    </div>
  );

  return (
    <div className="nt-table-wrap">
      {/* Hosted: the toolbar renders into the tab bar's right-hand cluster
          (owner 2026-10-12); un-hosted: it rides the body top as before. */}
      {chromeTarget !== null ? createPortal(toolbar, chromeTarget) : toolbar}
      <OutlinerContext.Provider value={outliner}>
      <table className={`nt-table${resizing !== null ? " nt-table--resizing" : ""}`} ref={tableRef}>
        <colgroup>
          {selectable && <col className="nt-table-select-col" />}
          {visibleColumns.map((column) => {
            const width = colWidths.get(column.id) ?? defaultColumnWidth(column);
            return <col key={column.id} style={{ width }} />;
          })}
        </colgroup>
        <thead>
          <tr>
            {selectable && (
              <th className="nt-table-select-col">
                <Checkbox
                  size="sm"
                  indeterminate={!allVisibleSelected && someVisibleSelected}
                  checked={allVisibleSelected}
                  onChange={() => {
                    setSelected(
                      allVisibleSelected
                        ? new Set()
                        : new Set(visible.map((row) => row.item.node.id)),
                    );
                  }}
                  aria-label="Select all loaded rows"
                />
              </th>
            )}
            {visibleColumns.map((column) => {
              // The sort register: every sorted column wears its direction
              // arrow; a multi-sort adds the priority index badge.
              const sortIndex = sort.findIndex((s) => s.key === column.id);
              const committed = colWidths.get(column.id);
              return (
                <th
                  key={column.id}
                  data-column-id={column.id}
                  aria-sort={
                    sort.length === 1 && sort[0]!.key === column.id
                      ? sort[0]!.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  <button
                    type="button"
                    className={`nt-table-sort${sortIndex !== -1 ? " nt-table-sort--active" : ""}`}
                    title={column.label}
                    onClick={() => cycleSort(column)}
                    disabled={column.sortable === false}
                  >
                    {column.label}
                    {sortIndex !== -1 && (
                      <>
                        <Icon
                          path={sort[sortIndex]!.direction === "asc" ? "mdi-arrow-up" : "mdi-arrow-down"}
                          size={0.7}
                        />
                        {sort.length > 1 && (
                          <span className="nt-table-sort-index">{sortIndex + 1}</span>
                        )}
                      </>
                    )}
                  </button>
                  {/* The resize divider (owner 2026-10-21): straddles the
                      header's right edge; the drag commits a px width
                      (minimum clamped), arrows nudge when focused. */}
                  <span
                    className="nt-table-resize"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${column.label}`}
                    {...(committed !== undefined ? { "aria-valuenow": committed } : {})}
                    tabIndex={0}
                    onPointerDown={(event) => beginColumnResize(event, column)}
                    onPointerMove={moveColumnResize}
                    onPointerUp={endColumnResize}
                    onPointerCancel={endColumnResize}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowLeft") {
                        event.preventDefault();
                        nudgeColumnWidth(column, -16);
                      } else if (event.key === "ArrowRight") {
                        event.preventDefault();
                        nudgeColumnWidth(column, 16);
                      }
                    }}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={row.item.node.id} data-node-id={row.item.node.id} className={selected.has(row.item.node.id) ? "nt-table-row--selected" : ""}>
              {selectable && (
                <td className="nt-table-select-col">
                  <Checkbox
                    size="sm"
                    checked={selected.has(row.item.node.id)}
                    onChange={() => toggleSelected(row.item.node.id)}
                    aria-label={`Select ${nodeDisplayName(row.item.node) || "Untitled"}`}
                  />
                </td>
              )}
              {visibleColumns.map((column) => renderCell(row, column))}
            </tr>
          ))}
        </tbody>
      </table>
      </OutlinerContext.Provider>
      <ShowMoreButton remaining={remaining} onShowMore={showMore} />
      {exportSelection !== null && (
        <ExportPageModal
          isOpen
          onClose={() => setExportSelection(null)}
          client={client}
          nodeUuids={exportSelection}
        />
      )}
      {importOpen && (
        <ImportTableModal
          isOpen
          onClose={() => setImportOpen(false)}
          client={client}
          titleHeader={visibleColumns.find((column) => column.kind === "name")?.label}
        />
      )}
    </div>
  );
}

registerView({
  id: "table",
  label: "Table",
  icon: "mdi-table",
  component: TableView,
  capabilities: { tableColumns: true, sorting: true },
});
