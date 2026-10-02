/**
 * TableView — the v1 table mode port: Name / Classes / Created plus
 * property columns resolved by the container. Session-local single-column
 * sort (header click cycles asc → desc → none; empty values always last),
 * windowed rows ("Show more", the v1 WINDOW_SIZE pattern). Cells are
 * read-only except boolean toggles and single-select dropdowns, which edit
 * inline through client.setProperty (the task checkbox flow); every row's
 * name opens the node, shift+click peeks.
 */

import { useMemo, useState } from "react";

import { BooleanToggle } from "../components/ui/index.js";
import { Icon } from "../Icon.js";
import { classIconMap, nodeIcon } from "../iconFor.js";
import { displayNameForSettings, displayNameFromClient } from "../dateDisplay.js";
import { registerView } from "./registry.js";
import { isEmptyPropertyValue, propertyDisplayText } from "./propertyDisplay.js";
import type { NodeCollectionItem, NodeCollectionProps, SortSpec, TableColumn } from "./types.js";
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

/** Column comparator over resolved rows; empty values sink to the bottom. */
function compareFor(
  client: NodeCollectionProps["client"],
  column: TableColumn,
  rowA: TableRow,
  rowB: TableRow,
): number {
  if (column.kind === "name") {
    return (displayNameForSettings(rowA.item.node) || "Untitled").localeCompare(
      displayNameForSettings(rowB.item.node) || "Untitled",
      undefined,
      { numeric: true, sensitivity: "base" },
    );
  }
  if (column.kind === "created") {
    return (rowA.item.node.createdAt ?? "").localeCompare(rowB.item.node.createdAt ?? "");
  }
  if (column.kind === "property" && column.propertySchemaId !== undefined) {
    const schema = client.listPropertySchemas().find((s) => s.id === column.propertySchemaId);
    const propA = rowA.properties.find((p) => p.propertySchemaId === column.propertySchemaId);
    const propB = rowB.properties.find((p) => p.propertySchemaId === column.propertySchemaId);
    if (schema?.type === "number" || schema?.type === "integer") {
      return (Number(propA?.value) || 0) - (Number(propB?.value) || 0);
    }
    if (schema?.type === "boolean") {
      return Number(propA?.value === true) - Number(propB?.value === true);
    }
    return propertyDisplayText(client, propA).localeCompare(propertyDisplayText(client, propB), undefined, {
      numeric: true,
    });
  }
  return 0;
}

/** Item + its resolved properties (fetched once per row for cell render). */
interface TableRow {
  item: NodeCollectionItem;
  properties: import("@/core/workspace-client.js").EffectiveProperty[];
}

function ClassChips({ item, props }: { item: NodeCollectionItem; props: NodeCollectionProps }) {
  const { client } = props;
  const classes = item.node.classIds
    .map((classId) => client.getNode(classId))
    .filter((node): node is import("@/core/workspace-client.js").ClientNode => node !== undefined);
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

  if (
    editable &&
    schema?.type === "select" &&
    schema.options !== null &&
    schema.options.length > 0 &&
    !schema.multi
  ) {
    const value = typeof prop?.value === "string" ? prop.value : "";
    return (
      <select
        className="nt-table-select"
        aria-label={schema.name}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "") void client.unsetProperty(row.item.node.id, schemaId, prop?.idx ?? 0);
          else void client.setProperty(row.item.node.id, schemaId, next, prop?.idx ?? 0);
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

  return <>{propertyDisplayText(client, prop)}</>;
}

export function TableView(props: NodeCollectionProps) {
  const { client, items, tableColumns, propertiesOf, onNodeClick, onNodeShiftClick, defaultSort } = props;
  const columns = tableColumns ?? DEFAULT_COLUMNS;
  const [sort, setSort] = useState<SortSpec | null>(defaultSort ?? null);
  const [windowEnd, setWindowEnd] = useState(ROW_WINDOW);

  const rows = useMemo<TableRow[]>(
    () => items.map((item) => ({ item, properties: propertiesOf?.(item.node.id) ?? [] })),
    [items, propertiesOf],
  );

  const sorted = useMemo(() => {
    if (sort === null) return rows;
    const column = columns.find((c) => c.id === sort.key);
    if (column === undefined || column.sortable === false) return rows;
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((rowA, rowB) => {
      if (column.kind === "property") {
        const propA = rowA.properties.find((p) => p.propertySchemaId === column.propertySchemaId);
        const propB = rowB.properties.find((p) => p.propertySchemaId === column.propertySchemaId);
        const emptyA = propA === undefined || isEmptyPropertyValue(propA.value);
        const emptyB = propB === undefined || isEmptyPropertyValue(propB.value);
        if (emptyA !== emptyB) return emptyA ? 1 : -1;
      }
      return compareFor(client, column, rowA, rowB) * direction;
    });
  }, [rows, sort, columns, client]);

  const visible = sorted.slice(0, windowEnd);
  const iconMap = classIconMap(client.listClasses());

  const cycleSort = (column: TableColumn) => {
    if (column.sortable === false) return;
    setSort((current) => {
      if (current === null || current.key !== column.id) return { key: column.id, direction: "asc" };
      if (current.direction === "asc") return { key: column.id, direction: "desc" };
      return null;
    });
  };

  if (items.length === 0) return null;

  return (
    <div className="nt-table-wrap">
      <table className="nt-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                aria-sort={
                  sort?.key === column.id
                    ? sort.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
              >
                <button
                  type="button"
                  className={`nt-table-sort${sort?.key === column.id ? " nt-table-sort--active" : ""}`}
                  onClick={() => cycleSort(column)}
                  disabled={column.sortable === false}
                >
                  {column.label}
                  {sort?.key === column.id && (
                    <Icon path={sort.direction === "asc" ? "mdi-arrow-up" : "mdi-arrow-down"} size={0.7} />
                  )}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const node = row.item.node;
            const label = displayNameForSettings(node) || "Untitled";
            const icon = nodeIcon(node, iconMap);
            return (
              <tr key={node.id} data-node-id={node.id}>
                {columns.map((column) => {
                  if (column.kind === "name") {
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
                    return <td key={column.id} className="nt-table-created">{formatCreated(node.createdAt)}</td>;
                  }
                  return (
                    <td key={column.id}>
                      <PropertyCell row={row} column={column} props={props} />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length > windowEnd && (
        <button type="button" className="nt-table-more" onClick={() => setWindowEnd((end) => end + ROW_WINDOW)}>
          Show more ({sorted.length - windowEnd} remaining)
        </button>
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
