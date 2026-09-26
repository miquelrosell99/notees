/**
 * PageView — a page: editable header title + the recursive block tree of
 * its children + the "add block" affordance for an empty page. Reads from a
 * client (in-process WorkspaceClient or the WorkerClient proxy — same
 * surface) and re-renders on its (naive) notifications.
 *
 * PageView also owns the OutlinerContext: the write surface, the per-render
 * outline position map (sibling/parent facts for Tab/Backspace), and the
 * focus request that hands the caret between blocks after structural
 * gestures.
 */

import { useEffect, useState } from "react";

import { buildOutlinePositions } from "@/editor/outline.js";
import type { CaretPlacement } from "@/editor/caret.js";
import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { BlockRow } from "./BlockRow.js";
import { TitleEditor } from "./TitleEditor.js";
import {
  OutlinerContext,
  type FocusRequest,
  type OutlinerContextValue,
} from "./outliner-context.js";

export function PageView({
  client,
  pageId,
}: {
  client: WorkspaceClient | WorkerClient;
  pageId: string;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);

  const page = client.getPage(pageId);
  const tree = page !== undefined ? client.getBlockTree(pageId) : [];

  const outliner: OutlinerContextValue = {
    client,
    positions: buildOutlinePositions(tree, pageId),
    focusRequest,
    requestFocus: (blockId: string, caret: CaretPlacement = "end") =>
      setFocusRequest({ id: blockId, caret }),
    acknowledgeFocus: () => setFocusRequest(null),
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
      </div>
    </OutlinerContext.Provider>
  );
}
