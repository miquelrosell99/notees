/**
 * Outliner editing context — provided by PageView, consumed by BlockRow /
 * BlockTextEditor / TitleEditor. `client` is the structural write surface,
 * satisfied by both WorkspaceClient and the WorkerClient proxy.
 */

import { createContext, useContext } from "react";

import type { CaretPlacement } from "@/editor/caret.js";
import type { OutlinePositionMap } from "@/editor/outline.js";
import type {
  CreateObjectInput,
  DeleteObjectOptions,
  UpdateObjectInput,
} from "@/core/workspace-client.js";

export interface OutlinerClient {
  createObject(partial: CreateObjectInput): Promise<string>;
  updateObject(id: string, fields: UpdateObjectInput): Promise<void>;
  deleteObject(id: string, opts?: DeleteObjectOptions): Promise<void>;
  /**
   * Reparent seam for indent/outdent (`object.move`). `afterId` lands the
   * node immediately after that sibling (Enter placement); omit it to append
   * at the end (Tab indent).
   */
  moveObject(id: string, parentId: string | null, afterId?: string): Promise<void>;
}

export interface FocusRequest {
  id: string;
  caret: CaretPlacement;
}

export interface OutlinerContextValue {
  client: OutlinerClient;
  /** Sibling/parent facts for the current tree (keyboard gestures). */
  positions: OutlinePositionMap;
  /** Pending focus request, consumed by the targeted BlockRow. */
  focusRequest: FocusRequest | null;
  requestFocus: (blockId: string, caret?: CaretPlacement) => void;
  acknowledgeFocus: () => void;
}

export const OutlinerContext = createContext<OutlinerContextValue | null>(null);

export function useOutliner(): OutlinerContextValue {
  const context = useContext(OutlinerContext);
  if (context === null) {
    throw new Error("useOutliner must be used inside PageView's OutlinerContext");
  }
  return context;
}
