/**
 * DailyNoteOutline — the calendar's Daily Note section body (owner
 * 2026-10-23): the active day page's child blocks as a standalone EDITABLE
 * outline — no PageView chrome (the view's top bar names the day, so no
 * header row at all). The composition mirrors the page body's collection
 * (PageView.tsx bodyContent) and the standalone-host precedent
 * (FocusedBlockView): the host's own OutlinerContext + EditThread
 * provider/overlay, the shared NodeCollection in outline/tree/editable mode
 * over childQuery (comments cut at every level, the body factory). The
 * trailing "+ Add block" ghost is the COLLECTION's chrome — the host
 * supplies only the write through `addGhost`. The app-wide
 * WorkspaceDndHost carries the DndContext the sortable rows consume.
 */

import { useRef } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";

import { NodeCollection } from "../collection/index.js";
import { childQuery } from "../collection/childQuery.js";
import { realizeGhost } from "../../ui/GhostRow.js";
import { OutlinerContext, useOutlinerValue } from "../../ui/outliner-context.js";
import { EditThreadOverlay, EditThreadProvider } from "../../ui/EditThread.js";

export function DailyNoteOutline({
  client,
  dayId,
  onOpenPage,
}: {
  client: WorkspaceClient | WorkerClient;
  /** The active day node's id — the outline's root. */
  dayId: string;
  onOpenPage: (nodeId: string) => void;
}) {
  const outliner = useOutlinerValue(client, dayId, { openNode: (id) => onOpenPage(id) });
  const hostRef = useRef<HTMLDivElement | null>(null);
  return (
    <OutlinerContext.Provider value={outliner}>
      <EditThreadProvider>
        <div ref={hostRef} className="nt-edit-thread-host">
          <EditThreadOverlay client={client} hostRef={hostRef} rootId={dayId} />
          <NodeCollection
            viewMode="outline"
            client={client}
            items={childQuery(client, dayId)}
            tree
            editable
            showBreadcrumbs={false}
            onNodeClick={(id) => onOpenPage(id)}
            addGhost={{
              parentId: dayId,
              onRealize: () => {
                void realizeGhost(client, outliner, dayId).catch((error: unknown) => {
                  console.warn(`[outliner] ghost realize (${dayId}) failed:`, error);
                });
              },
            }}
          />
        </div>
      </EditThreadProvider>
    </OutlinerContext.Provider>
  );
}
