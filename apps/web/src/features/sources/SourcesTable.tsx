/**
 * SourcesTable — the Sources hub's middle pane: the sortable, searchable
 * items table, NOTHING else (the toolbar moved to the
 * surface top bar and the hub owns the loaded set; this pane shows only
 * the table).
 *
 * The table RIDES the shared NodeCollection table view:
 * the library columns compose INTO its row renderer as `custom` columns
 * drawn from the task-2 display projection (each item's `meta.source` bag),
 * the sort is the view's OPTIONAL CONTROLLED seam (the URL owns the state,
 * law 9 — header clicks push ?sort=field:dir through the App's
 * navigateSources seam; the view's shared comparator sinks empties last in
 * both directions, Review Focus 2), and the row highlight + row click feed
 * the hub's single selection. The per-view toolbar hides (`toolbar={false}`)
 * — no chrome of its own.
 *
 * The hub feeds the pane its state: the projection items (the filtered
 * set), the first-read loading flag, the empty-LIBRARY flag, and the live
 * search string (the region's aria-label). Empty states: an empty LIBRARY
 * renders the New-flow hint (creation rides the
 * global New button: pick a source type, resolve a DOI/ISBN/arXiv link or
 * URL; no direct add-source door); filters excluding everything render the
 * honest "No sources match". Without a client (the URL-less shell tests)
 * the New-flow hint renders unchanged.
 */

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { AnyClient } from "../../ui/app/clients.js";
import { Icon } from "../../ui/Icon.js";
import { titleOf } from "../../ui/dateDisplay.js";
import { Badge, EmptyState, Spinner } from "../../components/ui/fleet/index.js";
import { NodeCollection } from "../collection/index.js";
import type { NodeCollectionItem, SortSpec, TableColumn } from "../collection/index.js";
import type { SourcesQueryState, SourcesSortField, SourceRow } from "./sourcesQuery.js";

import "./SourcesTable.css";

/** The container's per-row bag — the task-2 display projection. */
function sourceOf(item: NodeCollectionItem): SourceRow | undefined {
  return (item.meta as { source?: SourceRow } | undefined)?.source;
}

/** The primary type's display label (the class's live title). */
function typeLabelOf(client: AnyClient, row: SourceRow): string {
  const classId =
    SYSTEM_CLASS_UUIDS[row.classKey as keyof typeof SYSTEM_CLASS_UUIDS] ?? SYSTEM_CLASS_UUIDS.source;
  return titleOf(client, classId) ?? row.classKey;
}

/**
 * The library columns (the projection composes INTO the
 * shared table view's row renderer). Sortable lanes carry the comparator
 * value from the projection; the attachments badge is chrome, not a sort
 * field. Empty projection cells render blank (a read-only projection, not
 * the editable-cell "Empty" placeholder register).
 */
const SOURCES_COLUMNS: TableColumn[] = [
  {
    id: "type",
    kind: "custom",
    label: "Type",
    width: "13ch",
    sortable: false,
    renderCell: (item, client) => {
      const row = sourceOf(item);
      if (row === undefined) return null;
      const classId =
        SYSTEM_CLASS_UUIDS[row.classKey as keyof typeof SYSTEM_CLASS_UUIDS] ?? SYSTEM_CLASS_UUIDS.source;
      const icon = client.effectiveClassIcons().get(classId) ?? null;
      return (
        <span className="nt-sources-table__type">
          {icon !== null && <Icon path={icon} size={0.8} />}
          <span>{typeLabelOf(client, row)}</span>
        </span>
      );
    },
  },
  {
    id: "title",
    kind: "custom",
    label: "Title",
    width: "26ch",
    sortable: true,
    sortValue: (item) => sourceOf(item)?.title ?? "",
    csvText: (item) => sourceOf(item)?.title ?? "",
    renderCell: (item) => {
      const row = sourceOf(item);
      if (row === undefined) return null;
      // The plain title span rides the shared cell typography (owner
      // review round 2 — no projection-specific weight, no dead registers).
      return <span>{row.title}</span>;
    },
  },
  {
    id: "authors",
    kind: "custom",
    label: "Authors",
    width: "20ch",
    sortable: true,
    sortValue: (item) => sourceOf(item)?.authorsText ?? "",
    csvText: (item) => sourceOf(item)?.authorsText ?? "",
    renderCell: (item) => {
      const row = sourceOf(item);
      if (row === undefined) return null;
      return <span>{row.authorsText}</span>;
    },
  },
  {
    id: "year",
    kind: "custom",
    label: "Year",
    width: "7ch",
    sortable: true,
    sortValue: (item) => sourceOf(item)?.year ?? null,
    csvText: (item) => (sourceOf(item)?.year ?? "").toString(),
    renderCell: (item) => {
      const row = sourceOf(item);
      if (row === undefined) return null;
      return <span className="nt-sources-table__year">{row.year ?? ""}</span>;
    },
  },
  {
    id: "venue",
    kind: "custom",
    label: "Venue",
    width: "16ch",
    sortable: true,
    sortValue: (item) => sourceOf(item)?.venue ?? "",
    csvText: (item) => sourceOf(item)?.venue ?? "",
    renderCell: (item) => {
      const row = sourceOf(item);
      if (row === undefined) return null;
      return <span>{row.venue}</span>;
    },
  },
  {
    id: "citekey",
    kind: "custom",
    label: "Citekey",
    width: "18ch",
    sortable: true,
    sortValue: (item) => sourceOf(item)?.citekey ?? "",
    csvText: (item) => sourceOf(item)?.citekey ?? "",
    renderCell: (item) => {
      const row = sourceOf(item);
      if (row === undefined) return null;
      return <span>{row.citekey}</span>;
    },
  },
  {
    id: "attachments",
    kind: "custom",
    label: "Attachments",
    width: "8ch",
    sortable: false,
    renderCell: (item) => {
      const row = sourceOf(item);
      if (row === undefined || row.attachmentCount === 0) return null;
      return (
        <Badge size="xs" variant="neutral" className="nt-sources-table__attachments">
          <Icon path="mdi-paperclip" size={0.7} />
          {row.attachmentCount}
        </Badge>
      );
    },
  },
];

export function SourcesTable({
  client,
  query,
  onQueryChange,
  items,
  loading,
  libraryEmpty,
  q,
  selectedId,
  onSelect,
  onFocusDetail,
}: {
  client?: AnyClient | undefined;
  query: SourcesQueryState;
  onQueryChange?: ((next: SourcesQueryState, mode: "push" | "replace") => void) | undefined;
  /** The hub's filtered projection items (one NodeCollectionItem per row). */
  items: NodeCollectionItem[];
  /** The first library read is in flight (the spinner state). */
  loading: boolean;
  /** The WHOLE library is empty (vs the filters hiding everything). */
  libraryEmpty: boolean;
  /** The live search string (the region's aria-label). */
  q: string;
  /** The hub-owned single selection (drives SourcesDetail). */
  selectedId?: string | null | undefined;
  onSelect?: ((nodeId: string) => void) | undefined;
  /** Enter hands the focus to the detail pane (the keyboard-list idiom). */
  onFocusDetail?: (() => void) | undefined;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Keep the active row visible (the TemplateListPopup scroll convention).
  useEffect(() => {
    if (selectedId === null || selectedId === undefined) return;
    wrapRef.current
      ?.querySelector(`tr[data-node-id="${selectedId}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  if (client === undefined) {
    // The URL-less shell: the honest New-flow hint.
    return (
      <div
        className="nt-sources-hub__table nt-sources-table"
        role="region"
        aria-label={q !== "" ? `Sources matching “${q}”` : "Sources"}
      >
        <EmptyState
          icon={<Icon path="mdi-bookshelf" size={2} />}
          title="No sources yet"
          description="Press New in the top bar and pick a source type — resolve a DOI, ISBN, arXiv link or URL, or fill the form by hand."
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="nt-sources-hub__table nt-sources-table" role="region" aria-label="Sources">
        <Spinner />
      </div>
    );
  }

  if (libraryEmpty) {
    return (
      <div
        className="nt-sources-hub__table nt-sources-table"
        role="region"
        aria-label={q !== "" ? `Sources matching “${q}”` : "Sources"}
      >
        <EmptyState
          icon={<Icon path="mdi-bookshelf" size={2} />}
          title="No sources yet"
          description="Press New in the top bar and pick a source type — resolve a DOI, ISBN, arXiv link or URL, or fill the form by hand."
        />
      </div>
    );
  }

  const handleSortChange = (specs: SortSpec[]): void => {
    const spec = specs[0];
    onQueryChange?.(
      {
        ...query,
        sort:
          spec === undefined
            ? null
            : { field: spec.key as SourcesSortField, direction: spec.direction },
      },
      "push",
    );
  };

  const handleKeyDown = (event: ReactKeyboardEvent): void => {
    // The search box (and any editor) owns its own keys — the row
    // navigation answers only when the table itself holds the focus.
    if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    if (items.length === 0) return;
    const ids = items.map((item) => item.node.id);
    const index = selectedId === undefined || selectedId === null
      ? -1
      : ids.indexOf(selectedId);
    const last = ids.length - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = index === -1 ? 0 : Math.min(index + 1, last);
      onSelect?.(ids[next]!);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = index === -1 ? last : Math.max(index - 1, 0);
      onSelect?.(ids[next]!);
    } else if (event.key === "Enter") {
      if (selectedId !== undefined && selectedId !== null) {
        event.preventDefault();
        onFocusDetail?.();
      }
    }
  };

  return (
    <div
      ref={wrapRef}
      className="nt-sources-hub__table nt-sources-table"
      role="region"
      aria-label={q.trim() !== "" ? `Sources matching “${q.trim()}”` : "Sources"}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {items.length === 0 ? (
        <EmptyState
          icon={<Icon path="mdi-text-box-search-outline" size={2} />}
          title="No sources match"
          description="No sources match the current type and search filters."
        />
      ) : (
        <NodeCollection
          viewMode="table"
          client={client}
          items={items}
          tableColumns={SOURCES_COLUMNS}
          {...(query.sort !== null
            ? { sort: [{ key: query.sort.field, direction: query.sort.direction }] }
            : {})}
          {...(onQueryChange !== undefined ? { onSortChange: handleSortChange } : {})}
          toolbar={false}
          selectable={false}
          highlightedId={selectedId ?? null}
          onRowClick={(nodeId) => {
            onSelect?.(nodeId);
            wrapRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
