/**
 * TableView — the v1 table mode port, extended:
 *
 * - Columns: Name (fixed) + Classes/Created + property columns resolved by
 *   the container; a "Columns" panel toggles built-ins and adds/removes any
 *   workspace property (session state, defaults from the container).
 * - Sort: per-column header click sets a single quick sort; the "Sort"
 *   panel manages the full multi-column SortSpec list (add/remove,
 *   direction toggle, priority reorder).
 * - Rows: windowed ("Show more"); row checkboxes with a tri-state header
 *   box when `selectable` (default on) — selection is session state.
 * - Cells: boolean + select edit inline; text/url/email and number/integer
 *   commit on blur/Enter (empty unsets); date cells ride the shared
 *   DateSlotControl (the zoom picker, §34.32 PG17) writing a day-node
 *   reference (ensureDateChain); node cells open the anchored NodeSelector.
 *   Multi-value properties stay read-only.
 * - Name cell: row click opens, shift+click peeks.
 * - CSV export (§34.59, extended §34.69): the toolbar's "Export CSV"
 *   downloads the CURRENT view — the visible columns × the full sorted
 *   result set (the window is display-only, never an export cut) — through
 *   @notees/export's renderCsv (RFC-4180 quoting + UTF-8 BOM for Excel), and
 *   a live selection additionally offers "Export selected CSV" — the same
 *   columns scoped to exactly the checked rows. A selection also offers
 *   "Export selected…": the export modal's batch path over just the checked
 *   row ids (the §34.24 parked row "selection-scoped export").
 */

import { useMemo, useRef, useState, type ReactNode } from "react";
import { parseDateNodeId } from "@notees/domain";
import { renderCsv } from "@notees/export";

import { BooleanToggle, Button, ButtonWithPanel, Checkbox } from "../components/ui/index.js";
import { Icon } from "../Icon.js";
import { NodeSelector } from "../components/pickers/NodeSelector.js";
import { DateSlotControl } from "../components/pickers/DateSlotControl.js";
import { ExportPageModal } from "../components/modals/ExportPageModal.js";
import { downloadBlob } from "../components/modals/download.js";
import { classIconMap, nodeIcon } from "../iconFor.js";
import { displayNameForSettings, displayNameFromClient } from "../dateDisplay.js";
import { registerView } from "./registry.js";
import { isEmptyPropertyValue, propertyDisplayText, propertyLinkHref } from "./propertyDisplay.js";
import type { ClientNode, EffectiveProperty } from "@/core/workspace-client.js";
import type {
  AnyClient,
  NodeCollectionItem,
  NodeCollectionProps,
  SortSpec,
  TableColumn,
} from "./types.js";
import "./TableView.css";

/** Rows per window (the v1 WINDOW_SIZE pattern). */
const ROW_WINDOW = 100;

const DEFAULT_COLUMNS: TableColumn[] = [
  { id: "name", kind: "name", label: "Name", sortable: true },
  { id: "classes", kind: "classes", label: "Classes", sortable: false },
  { id: "created", kind: "created", label: "Created", sortable: true },
];

function formatCreated(createdAt: string | null): string {
  if (createdAt === null) return "";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The CSV projection of one cell — the same display text the row renders
 * (names, class labels, the locale created date, property display strings),
 * so the downloaded file is WYSIWYG against the on-screen table. Raw ids
 * never leak: the conventions above resolve targets to current names.
 */
function csvCellText(client: AnyClient, row: TableRow, column: TableColumn): string {
  const node = row.item.node;
  if (column.kind === "name") return displayNameForSettings(node) || "Untitled";
  if (column.kind === "classes") {
    return node.classIds
      .map((classId) => displayNameFromClient(client, classId))
      .filter((name): name is string => name !== null && name !== undefined)
      .join(", ");
  }
  if (column.kind === "created") return formatCreated(node.createdAt);
  if (column.kind === "isClass") return node.isClass ? "Yes" : "—";
  if (column.kind === "presentAsMain") return node.presentAsMain ? "Yes" : "—";
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
    return displayNameForSettings(row.item.node) || "Untitled";
  }
  if (column.kind === "created") {
    return row.item.node.createdAt ?? "";
  }
  if (column.kind === "isClass") {
    return row.item.node.isClass ? 1 : 0;
  }
  if (column.kind === "presentAsMain") {
    return row.item.node.presentAsMain ? 1 : 0;
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
          {displayNameFromClient(client, cls.id) ?? cls.id}
        </span>
      ))}
    </span>
  );
}

/** Click-to-edit inline input: commit on blur/Enter, cancel on Escape. */
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
      value={draft}
      autoFocus
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

/** The draft shown in a text cell: the carrier's raw text when node-backed. */
function textCellDraft(client: AnyClient, prop: EffectiveProperty | undefined): string {
  const ref = carrierRefOf(prop?.value);
  if (ref !== null) {
    const node = client.getNode(ref);
    if (node !== undefined) {
      return node.contentAst
        .map((token) => (token.type === "text" ? (token.text ?? "") : ""))
        .join("");
    }
  }
  return propertyDisplayText(client, prop);
}

/**
 * Text-property cell commit — node-backed per SCHEMA.md (PB2 one-shape-per-
 * type): strings no longer ride property.set directly. Editing an existing
 * carrier writes its content; a fresh value creates a carrier child of the
 * row node and links {nodeId}; clearing unsets (whose applier trashes the
 * orphaned carrier).
 */
async function commitTextCellValue(
  props: NodeCollectionProps,
  row: TableRow,
  schemaId: string,
  idx: number | undefined,
  next: string,
): Promise<void> {
  const { client } = props;
  const nodeId = row.item.node.id;
  if (next === "") {
    if (idx !== undefined) await client.unsetProperty(nodeId, schemaId, idx);
    return;
  }
  const prop = row.properties.find(
    (p) => p.propertySchemaId === schemaId && (idx === undefined || p.idx === idx),
  );
  const existing = carrierRefOf(prop?.value);
  if (existing !== null && client.getNode(existing) !== undefined) {
    await client.updateObject(existing, { contentAst: [{ type: "text", text: next }] });
    return;
  }
  const carrier = await client.createObject({
    parentId: nodeId,
    contentAst: [{ type: "text", text: next }],
  });
  await client.setProperty(nodeId, schemaId, { nodeId: carrier }, idx ?? 0);
}

function DateCell({ row, schemaId, props, schemaName }: { row: TableRow; schemaId: string; props: NodeCollectionProps; schemaName: string }) {
  const { client } = props;
  const prop = row.properties.find((p) => p.propertySchemaId === schemaId);
  const target = prop?.value as { nodeId?: unknown } | undefined;
  const targetId = typeof target?.nodeId === "string" ? target.nodeId : null;
  const parsed = targetId !== null ? parseDateNodeId(targetId) : null;
  const iso =
    parsed !== null && parsed.precision === "day"
      ? `${String(parsed.year).padStart(4, "0")}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`
      : null;
  return (
    <DateSlotControl
      client={client}
      value={iso}
      display={iso ?? propertyDisplayText(client, prop)}
      ariaLabel={schemaName}
      onCommit={(next) => {
        if (next === iso) return;
        if (next === null) {
          commitCellValue(props, row, schemaId, prop?.idx, null);
          return;
        }
        void client.ensureDateChain(next).then(({ day }) => {
          commitCellValue(props, row, schemaId, prop?.idx, { nodeId: day });
        });
      }}
    />
  );
}

function NodeCell({ row, schemaId, props, schemaName }: { row: TableRow; schemaId: string; props: NodeCollectionProps; schemaName: string }) {
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
        onClick={() => setOpen(true)}
      >
        {targetId !== null ? (displayNameFromClient(props.client, targetId) ?? targetId) : schemaName}
      </button>
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

function PropertyCell({ row, column, props }: { row: TableRow; column: TableColumn; props: NodeCollectionProps }) {
  const { client, tableEditable = false } = props;
  const schemaId = column.propertySchemaId!;
  const schema = client.listPropertySchemas().find((s) => s.id === schemaId);
  const prop = row.properties.find((p) => p.propertySchemaId === schemaId);
  const editable = tableEditable && prop?.readonly !== true;

  if (editable && schema?.type === "boolean") {
    return (
      <BooleanToggle
        size="sm"
        checked={prop?.value === true}
        onChange={(event) => {
          void client.setProperty(row.item.node.id, schemaId, event.target.checked, prop?.idx ?? 0);
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
      return (
        <InlineInput
          value={textCellDraft(client, prop)}
          ariaLabel={schema.name}
          onCommit={(next) => void commitTextCellValue(props, row, schemaId, prop?.idx, next)}
        />
      );
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

  if (editable && schema?.type === "date" && schema?.multi !== true) {
    return <DateCell row={row} schemaId={schemaId} props={props} schemaName={schema.name} />;
  }

  if (editable && schema?.type === "object" && schema?.multi !== true) {
    return <NodeCell row={row} schemaId={schemaId} props={props} schemaName={schema.name} />;
  }

  // §34.32 PG14: url/email values render as links (mailto: for email; a url
  // value keeps whatever scheme the author wrote, tel: included).
  const href = propertyLinkHref(schema?.type, prop?.value);
  if (href !== null) {
    return (
      <a className="nt-table-link" href={href} target="_blank" rel="noreferrer">
        {propertyDisplayText(client, prop)}
      </a>
    );
  }

  return <>{propertyDisplayText(client, prop)}</>;
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
            ×
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
  const { client, items, tableColumns, propertiesOf, onNodeClick, onNodeShiftClick, defaultSort } = props;
  const columns = tableColumns ?? DEFAULT_COLUMNS;
  const [sort, setSort] = useState<SortSpec[]>(defaultSort !== undefined ? [defaultSort] : []);
  const [windowEnd, setWindowEnd] = useState(ROW_WINDOW);
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(new Set());
  const [extraColumns, setExtraColumns] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [exportSelection, setExportSelection] = useState<string[] | null>(null);
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

  const visibleColumns = useMemo(() => {
    const base = columns.filter((c) => c.kind === "name" || !hiddenColumns.has(c.id));
    const extras: TableColumn[] = [...extraColumns]
      .map((id) => extraPool.find((s) => s.id === id))
      .filter((s): s is { id: string; name: string } => s !== undefined)
      .map((s) => ({ id: s.id, kind: "property" as const, label: s.name, propertySchemaId: s.id, sortable: true }));
    return [...base, ...extras];
  }, [columns, hiddenColumns, extraColumns, extraPool]);

  const sorted = useMemo(() => {
    if (sort.length === 0) return rows;
    return [...rows].sort((rowA, rowB) => compareRows(client, sort, visibleColumns, rowA, rowB));
  }, [rows, sort, client, visibleColumns]);

  const visible = sorted.slice(0, windowEnd);
  const iconMap = classIconMap(client.listClasses());

  const cycleSort = (column: TableColumn) => {
    if (column.sortable === false) return;
    setSort((current) => {
      const existing = current.find((s) => s.key === column.id);
      if (existing === undefined) return [{ key: column.id, direction: "asc" }];
      if (existing.direction === "asc") return [{ key: column.id, direction: "desc" }];
      return [];
    });
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
  const allVisibleSelected = visible.length > 0 && visible.every((row) => selected.has(row.item.node.id));
  const someVisibleSelected = visible.some((row) => selected.has(row.item.node.id));
  const headerCheckboxRef = useRef<HTMLInputElement | null>(null);
  const setHeaderCheckbox = (el: HTMLInputElement | null) => {
    if (el !== null) el.indeterminate = !allVisibleSelected && someVisibleSelected;
    headerCheckboxRef.current = el;
  };

  /**
   * "Export CSV" — the current view: visible columns × the FULL sorted
   * result set (the row window is a display convenience, never an export
   * cut). The package serializer owns quoting/escaping + the UTF-8 BOM;
   * the Blob is typed text/csv so the download carries the encoding.
   * `rows` scopes the export (§34.69): the whole sorted set, or — from the
   * selection chrome — exactly the checked rows.
   */
  const handleExportCsv = (rows: readonly TableRow[], stem: string) => {
    const csv = renderCsv(
      visibleColumns.map((column) => column.label),
      rows.map((row) => visibleColumns.map((column) => csvCellText(client, row, column))),
    );
    const safeStem = stem.replace(/[\\/:*?"<>|]/g, "-");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, `${safeStem}.csv`);
  };
  const baseStem = (props.exportFileName ?? "table-export").replace(/[\\/:*?"<>|]/g, "-");
  const selectedRows = sorted.filter((row) => selected.has(row.item.node.id));

  if (items.length === 0) return null;

  const renderCell = (row: TableRow, column: TableColumn): ReactNode => {
    const node = row.item.node;
    if (column.kind === "name") {
      const label = displayNameForSettings(node) || "Untitled";
      const icon = nodeIcon(node, iconMap);
      return (
        <td key={column.id} className="nt-table-name">
          <button
            type="button"
            className="nt-table-name-btn"
            title={label}
            onClick={(event) => {
              if (event.shiftKey) onNodeShiftClick?.(node.id);
              else onNodeClick?.(node.id);
            }}
          >
            {icon !== null && <Icon path={icon} size={0.9} className="nt-table-name-icon" />}
            <span className="nt-table-name-label">{label}</span>
          </button>
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
      return (
        <td key={column.id} className="nt-table-created">
          {formatCreated(node.createdAt)}
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
    if (column.kind === "presentAsMain") {
      return (
        <td key={column.id} className="nt-table-node-type">
          {node.presentAsMain ? "Yes" : "—"}
        </td>
      );
    }
    return (
      <td key={column.id}>
        <PropertyCell row={row} column={column} props={props} />
      </td>
    );
  };

  return (
    <div className="nt-table-wrap">
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
        <Button
          variant="ghost"
          size="sm"
          icon="mdi mdi-file-delimited-outline"
          onClick={() => handleExportCsv(sorted, baseStem)}
          aria-label="Export CSV"
          title="Download the current view's rows as CSV"
        >
          Export CSV
        </Button>
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
                .filter((c) => c.kind === "classes" || c.kind === "created" || c.kind === "isClass" || c.kind === "presentAsMain")
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
          {() => <SortPanel sort={sort} onChange={setSort} columns={visibleColumns} />}
        </ButtonWithPanel>
      </div>
      <table className="nt-table">
        <thead>
          <tr>
            {selectable && (
              <th className="nt-table-select-col">
                <Checkbox
                  size="sm"
                  ref={setHeaderCheckbox}
                  checked={allVisibleSelected}
                  onChange={() => {
                    setSelected(
                      allVisibleSelected
                        ? new Set()
                        : new Set(visible.map((row) => row.item.node.id)),
                    );
                  }}
                  aria-label="Select all rows"
                />
              </th>
            )}
            {visibleColumns.map((column) => (
              <th
                key={column.id}
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
                  className={`nt-table-sort${sort.some((s) => s.key === column.id) ? " nt-table-sort--active" : ""}`}
                  onClick={() => cycleSort(column)}
                  disabled={column.sortable === false}
                >
                  {column.label}
                  {sort.length === 1 && sort[0]!.key === column.id && (
                    <Icon path={sort[0]!.direction === "asc" ? "mdi-arrow-up" : "mdi-arrow-down"} size={0.7} />
                  )}
                </button>
              </th>
            ))}
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
                    aria-label={`Select ${displayNameForSettings(row.item.node) || "Untitled"}`}
                  />
                </td>
              )}
              {visibleColumns.map((column) => renderCell(row, column))}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > windowEnd && (
        <button type="button" className="nt-table-more" onClick={() => setWindowEnd((end) => end + ROW_WINDOW)}>
          Show more ({sorted.length - windowEnd} remaining)
        </button>
      )}
      {exportSelection !== null && (
        <ExportPageModal
          isOpen
          onClose={() => setExportSelection(null)}
          client={client}
          nodeUuids={exportSelection}
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
