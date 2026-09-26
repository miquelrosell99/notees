/**
 * Outliner editing context — provided by PageView, consumed by BlockRow /
 * BlockTextEditor / TitleEditor. `client` is the structural write surface,
 * satisfied by both WorkspaceClient and the WorkerClient proxy.
 */

import { createContext, useContext } from "react";

import type { CaretPlacement } from "@/editor/caret.js";
import type { OutlinePositionMap } from "@/editor/outline.js";
import type {
  ClientNode,
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
  /**
   * OR-set class membership add — the `#` / `+` "set" gesture. No-op when
   * the class is already assigned; otherwise appends to the node's class_ids
   * (read-modify-write over the node's current class_ids).
   */
  assignClass(id: string, classId: string): Promise<void>;
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
  /**
   * Capture-gesture reads ([[ mention, # chip): filtered node search, the
   * class list, and name resolution for candidate rows. Provided by
   * PageView from the full client surface (in-process or worker proxy).
   */
  capture: {
    searchNodes(query: string): ClientNode[];
    listClasses(): ClientNode[];
    displayName(id: string): string | null;
  };
}

export const OutlinerContext = createContext<OutlinerContextValue | null>(null);

export function useOutliner(): OutlinerContextValue {
  const context = useContext(OutlinerContext);
  if (context === null) {
    throw new Error("useOutliner must be used inside PageView's OutlinerContext");
  }
  return context;
}
