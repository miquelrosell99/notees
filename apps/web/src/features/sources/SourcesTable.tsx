/**
 * SourcesTable — the Sources hub's middle pane: the sortable, searchable
 * items table + the hub toolbar.
 *
 * The table RIDES the shared NodeCollection table view:
 * the library columns compose INTO its row renderer as `custom` columns
 * drawn from the task-2 display projection (each item's `meta.source` bag),
 * the sort is the view's OPTIONAL CONTROLLED seam (the URL owns the state,
 * law 9 — header clicks push ?sort=field:dir through the App's
 * navigateSources seam; the view's shared comparator sinks empties last in
 * both directions, Review Focus 2), and the row highlight + row click feed
 * the hub's single selection. The per-view toolbar hides (`toolbar={false}`)
 * — this pane owns the chrome.
 *
 * The toolbar: the search box (live filter over the loaded set by
 * title/authorsText/citekey — the exported rowMatchesQ predicate; the URL
 * follows debounced with replace semantics), the item count ("N sources"),
 * the filtered-set bibliography exports (.bib + CSL-JSON through the shipped
 * exportSubtreeBibliography over exactly the displayed row ids — Review
 * Focus 5), the Add-source door (the shipped requestAddSource seam), and a
 * settings shortcut opening the workspace settings on the Sources section
 * (the WorkspaceSettingsHost seam).
 *
 * Empty states: an empty LIBRARY renders the Add-first-source hint (the
 * task-1 door); filters excluding everything render the honest
 * "No sources match" — the toolbar stays so the filters can be undone.
 * Without a client (the URL-less shell tests) the task-1 empty state
 * renders unchanged.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { AnyClient } from "../../ui/app/clients.js";
import { Icon } from "../../ui/Icon.js";
import { titleOf } from "../../ui/dateDisplay.js";
import { Badge, Button, EmptyState, SearchField, Spinner } from "../../components/ui/fleet/index.js";
import { NodeCollection } from "../collection/index.js";
import type { NodeCollectionItem, SortSpec, TableColumn } from "../collection/index.js";
import { exportSubtreeBibliography } from "../export/exportSubtree.js";
import { downloadBlob } from "../modals/download.js";
import { requestAddSource } from "./AddSourceHost.js";
import { requestWorkspaceSettings } from "../workspaces/WorkspaceSettingsHost.js";
import {
  rowMatchesQ,
  runSourcesQuery,
  type SourceRow,
  type SourcesQueryState,
  type SourcesSortField,
} from "./sourcesQuery.js";

import "./SourcesTable.css";

/** The search box → URL debounce (typing must not thrash the history). */
const Q_DEBOUNCE_MS = 200;

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
      return <span className="nt-sources-table__title">{row.title}</span>;
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
      return <span className="nt-sources-table__citekey">{row.citekey}</span>;
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
  selectedId,
  onSelect,
  onFocusDetail,
}: {
  client?: AnyClient | undefined;
  query: SourcesQueryState;
  onQueryChange?: ((next: SourcesQueryState, mode: "push" | "replace") => void) | undefined;
  /** The hub-owned single selection (drives SourcesDetail). */
  selectedId?: string | null | undefined;
  onSelect?: ((nodeId: string) => void) | undefined;
  /** Enter hands the focus to the detail pane (the keyboard-list idiom). */
  onFocusDetail?: (() => void) | undefined;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState<SourceRow[] | null>(null);
  /** True when the WHOLE library is empty (vs the filters hiding everything). */
  const [libraryEmpty, setLibraryEmpty] = useState(false);
  // Live by subscription (the facets-pane idiom): a write elsewhere —
  // adding a source, enabling a hidden type — re-reads the loaded set.
  const [version, setVersion] = useState(0);
  useEffect(() => client?.subscribe(() => setVersion((v) => v + 1)), [client]);

  // The search box is a local, live filter; the URL follows debounced.
  const [qInput, setQInput] = useState(query.q);
  useEffect(() => {
    setQInput(query.q);
  }, [query.q]);
  // Latest-query ref: the debounce effect keys on the typed value only, so
  // an unrelated re-render with a new query object must not reset its timer.
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    if (onQueryChange === undefined) return;
    const handle = window.setTimeout(() => {
      if (qInput !== queryRef.current.q) {
        onQueryChange({ ...queryRef.current, q: qInput }, "replace");
      }
    }, Q_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [qInput, onQueryChange]);

  // The loaded set: one class-scoped AST run per picked type; the q narrow
  // is the client-side contract (see sourcesQuery — the linkedAuthors
  // derivation no store condition can express). Fine at library scale.
  // `version` re-runs the read on every client notify (the subscription).
  useEffect(() => {
    if (client === undefined) return;
    let cancelled = false;
    void version;
    void (async () => {
      try {
        const result = await runSourcesQuery(client, { classKey: query.type, q: "" }, null);
        if (!cancelled) setRows(result);
      } catch (error) {
        // A late read on a closing store (or a transient mid-write apply)
        // keeps the last rendered rows — never an unhandled rejection.
        if (!cancelled) console.warn("[sources] items-table re-read failed:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, query.type, version]);

  // The empty-LIBRARY check runs only when the filtered set reads empty —
  // it asks whether ANY source exists at all (unfiltered, unsorted).
  useEffect(() => {
    if (client === undefined || rows === null || rows.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const all = await runSourcesQuery(client, {}, null);
        if (!cancelled) setLibraryEmpty(all.length === 0);
      } catch (error) {
        if (!cancelled) console.warn("[sources] library check failed:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, rows]);

  const displayRows = useMemo(() => {
    if (rows === null) return null;
    const q = qInput.trim().toLowerCase();
    return q === "" ? rows : rows.filter((row) => rowMatchesQ(row, q));
  }, [rows, qInput]);

  const items = useMemo<NodeCollectionItem[]>(() => {
    if (client === undefined || displayRows === null) return [];
    return displayRows.flatMap((row) => {
      const node = client.getNode(row.id);
      return node === undefined ? [] : [{ node, meta: { source: row } }];
    });
  }, [client, displayRows]);

  // Keep the active row visible (the TemplateListPopup scroll convention).
  useEffect(() => {
    if (selectedId === null || selectedId === undefined) return;
    wrapRef.current
      ?.querySelector(`tr[data-node-id="${selectedId}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);

  if (client === undefined) {
    // The URL-less shell (task 1): the honest empty state + the door.
    return (
      <div
        className="nt-sources-hub__table nt-sources-table"
        role="region"
        aria-label={query.q !== "" ? `Sources matching “${query.q}”` : "Sources"}
      >
        <EmptyState
          icon={<Icon path="mdi-bookshelf" size={2} />}
          title="No sources yet"
          description="Add your first source — paste a DOI, ISBN, arXiv link or a URL."
          actionLabel="Add source"
          onAction={() => requestAddSource({})}
        />
      </div>
    );
  }

  if (rows === null) {
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
        aria-label={query.q !== "" ? `Sources matching “${query.q}”` : "Sources"}
      >
        <EmptyState
          icon={<Icon path="mdi-bookshelf" size={2} />}
          title="No sources yet"
          description="Add your first source — paste a DOI, ISBN, arXiv link or a URL."
          actionLabel="Add source"
          onAction={() => requestAddSource({})}
        />
      </div>
    );
  }

  const count = displayRows?.length ?? 0;

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

  const exportSet = (format: "bib" | "csl-json"): void => {
    if (displayRows === null || displayRows.length === 0) return;
    // Review Focus 5: exactly the CURRENT filtered set — the displayed row
    // ids, no child pages (a source's subtree is not bibliography).
    const exported = exportSubtreeBibliography(
      client,
      displayRows.map((row) => row.id),
      { format, includeChildPages: false },
    );
    downloadBlob(exported.blob, exported.filename);
  };

  const handleKeyDown = (event: ReactKeyboardEvent): void => {
    // The search box (and any editor) owns its own keys — the row
    // navigation answers only when the table itself holds the focus.
    if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    if (displayRows === null || displayRows.length === 0) return;
    const index = selectedId === undefined || selectedId === null
      ? -1
      : displayRows.findIndex((row) => row.id === selectedId);
    const last = displayRows.length - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = index === -1 ? 0 : Math.min(index + 1, last);
      onSelect?.(displayRows[next]!.id);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = index === -1 ? last : Math.max(index - 1, 0);
      onSelect?.(displayRows[next]!.id);
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
      aria-label={qInput.trim() !== "" ? `Sources matching “${qInput.trim()}”` : "Sources"}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="nt-sources-table__toolbar">
        <SearchField
          size="sm"
          aria-label="Search sources"
          placeholder="Search title, author, or citekey"
          value={qInput}
          onChange={(event) => setQInput(event.target.value)}
          onClear={() => setQInput("")}
        />
        <span className="nt-sources-table__count" aria-live="polite">
          {count} {count === 1 ? "source" : "sources"}
        </span>
        <span className="nt-sources-table__spacer" />
        <Button
          variant="ghost"
          size="sm"
          icon="mdi-file-export-outline"
          disabled={count === 0}
          onClick={() => exportSet("bib")}
        >
          BibTeX
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="mdi-code-braces"
          disabled={count === 0}
          onClick={() => exportSet("csl-json")}
        >
          CSL JSON
        </Button>
        <Button variant="primary" size="sm" icon="mdi-plus" onClick={() => requestAddSource({})}>
          Add source
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="mdi-cog-outline"
          aria-label="Sources settings"
          title="Sources settings"
          onClick={() => requestWorkspaceSettings()}
        />
      </div>
      {count === 0 ? (
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
