/**
 * PageView — a page: editable header title + the recursive block tree of
 * its children + the "add block" affordance for an empty page + the page's
 * system sections (linked references, unlinked references, child pages) per
 * SCHEMA.md: collapsed by default, no query until first expand. Reads from a
 * client (in-process WorkspaceClient or the WorkerClient proxy — same
 * surface) and re-renders on its (naive) notifications.
 *
 * PageView also owns the OutlinerContext: the write surface, the per-render
 * outline position map (sibling/parent facts for Tab/Backspace), and the
 * focus request that hands the caret between blocks after structural
 * gestures.
 */

import { useCallback, useEffect, useState } from "react";

import { deriveDisplayName } from "@notees/domain";

import { buildOutlinePositions } from "@/editor/outline.js";
import type { CaretPlacement } from "@/editor/caret.js";
import type { WorkerClient } from "@/core/worker-client.js";
import type { ReferenceEntry, WorkspaceClient } from "@/core/workspace-client.js";

import { BlockRow } from "./BlockRow.js";
import { Section } from "./Section.js";
import { TitleEditor } from "./TitleEditor.js";
import {
  OutlinerContext,
  type FocusRequest,
  type OutlinerContextValue,
} from "./outliner-context.js";

/** One references row: containing-page breadcrumb, source excerpt, containment context. */
function ReferenceList({
  entries,
  onOpenPage,
}: {
  entries: ReferenceEntry[];
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  return (
    <ul className="nt-section-list">
      {entries.map((entry) => (
        <li key={entry.source.id}>
          <button
            type="button"
            className="nt-section-item"
            onClick={() => onOpenPage?.(entry.containingPageId)}
          >
            <span className="nt-section-crumb">{entry.containingPageName}</span>
            {entry.source.id !== entry.containingPageId && (
              <span className="nt-section-source">
                {" › "}
                {deriveDisplayName(entry.source) || entry.source.id}
              </span>
            )}
            {entry.kind === "containment" && (
              <span className="nt-section-context">in {entry.containingPageName}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PageView({
  client,
  pageId,
  onOpenPage,
}: {
  client: WorkspaceClient | WorkerClient;
  pageId: string;
  /** Page navigation (child-pages rows, reference crumbs). */
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);

  // Section queries (SCHEMA.md lazy-loading contract): the closures are
  // created here but only INVOKED by Section after the first expand.
  const loadLinkedRefs = useCallback(() => client.getLinkedReferences(pageId), [client, pageId]);
  const loadUnlinkedRefs = useCallback(() => client.getUnlinkedReferences(pageId), [client, pageId]);
  const loadChildPages = useCallback(() => client.getChildPages(pageId), [client, pageId]);

  const page = client.getPage(pageId);
  const tree = page !== undefined ? client.getBlockTree(pageId) : [];

  const outliner: OutlinerContextValue = {
    client,
    positions: buildOutlinePositions(tree, pageId),
    focusRequest,
    requestFocus: (blockId: string, caret: CaretPlacement = "end") =>
      setFocusRequest({ id: blockId, caret }),
    acknowledgeFocus: () => setFocusRequest(null),
    capture: {
      /**
       * `@` mention candidates, by DISPLAY NAME (SCHEMA.md derivation). The
       * FTS index covers content plaintext AND stored names, so FTS hits are
       * unioned with pages + classes and filtered client-side by display name
       * (the filter keeps the name matches and drops nothing the pools did
       * not already surface).
       */
      searchNodes: (query) => {
        const q = query.trim().toLowerCase();
        const pool = [
          ...client.listPages(),
          ...client.listClasses(),
          ...(q === "" ? [] : client.search(query)),
        ];
        const seen = new Set<string>();
        return pool.filter((node) => {
          if (seen.has(node.id)) return false;
          seen.add(node.id);
          if (q === "") return true;
          return (client.getDisplayName(node.id) ?? "").toLowerCase().includes(q);
        });
      },
      listClasses: () => client.listClasses(),
      displayName: (id) => client.getDisplayName(id),
    },
  };

  if (!page) {
    return <div className="nt-page-missing">Page not found.</div>;
  }

  const addFirstBlock = async () => {
    const id = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [],
    });
    outliner.requestFocus(id, "start");
  };

  return (
    <OutlinerContext.Provider value={outliner}>
      <div className="nt-page">
        <header className="nt-page-header">
          <TitleEditor page={page} />
        </header>
        <div className="nt-block-tree">
          {tree.map((child) => (
            <BlockRow key={child.node.id} tree={child} resolveName={(id) => client.getDisplayName(id)} />
          ))}
        </div>
        {tree.length === 0 && (
          <button type="button" className="nt-add-block" onClick={() => void addFirstBlock()}>
            + Add a block
          </button>
        )}
        <div className="nt-page-sections">
          <Section
            key={`linked-${pageId}`}
            client={client}
            title="Linked references"
            badge={client.getBacklinkCount(pageId)}
            load={loadLinkedRefs}
            emptyText="No linked references."
            renderResults={(entries) => <ReferenceList entries={entries} onOpenPage={onOpenPage} />}
          />
          <Section
            key={`unlinked-${pageId}`}
            client={client}
            title="Unlinked references"
            load={loadUnlinkedRefs}
            emptyText="No unlinked references."
            renderResults={(entries) => <ReferenceList entries={entries} onOpenPage={onOpenPage} />}
          />
          <Section
            key={`child-${pageId}`}
            client={client}
            title="Child pages"
            badge={client.getChildPageCount(pageId)}
            load={loadChildPages}
            emptyText="No child pages."
            renderResults={(pages) => (
              <ul className="nt-section-list">
                {pages.map((child) => (
                  <li key={child.id}>
                    <button
                      type="button"
                      className="nt-section-item"
                      onClick={() => onOpenPage?.(child.id)}
                    >
                      <span className="nt-bullet" aria-hidden="true">
                        •
                      </span>
                      <span>{deriveDisplayName(child) || child.id}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          />
        </div>
      </div>
    </OutlinerContext.Provider>
  );
}
