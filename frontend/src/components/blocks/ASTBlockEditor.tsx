/**
 * ASTBlockEditor — AST-first contenteditable block editor.
 *
 * This component replaces the legacy string-based BlockEditor.
 * The AST is the SINGLE SOURCE OF TRUTH. The DOM is rebuilt from
 * the AST on every mutation, and user edits are extracted from
 * the DOM back into AST form via domToAST().
 *
 * Key design decisions:
 * - AST is parsed on mount from `content` (string) via parseAST()
 * - On every input event, domToAST() extracts the new AST
 * - The AST is serialized back to string via JSON.stringify and
 *   passed to onChange()
 * - Cursor position is tracked in logical characters (pills=1)
 * - Undo/redo operates on AST snapshots
 * - Trigger system (@ # [[ /) reads from plain text at cursor
 */

import {
  useRef,
  useCallback,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';

// CSS — reuse existing styles
import './BlockEditor.css';
import './InlineNodeLink.css';

// UI components
import { SuggestionPopup, type SuggestionType } from '../SuggestionPopup';
import { SlashCommandPopup } from '../SlashCommandPopup';
import { TextField } from '../core/TextField';
import { Button } from '../core/Button';
import { FloatingToolbar } from '../core/FloatingToolbar';
import { ContextMenu, type ContextMenuItem } from '../core/ContextMenu';

// Hooks
import { useNodes, useTextLinks, useClasses } from '@/hooks';
import { useNodesStore } from '@/stores';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { usePendingSelectionForBlock, useEditorSelectionActions } from '@/stores/selectors';

// Utils
import { getEffectiveIcon } from '@/utils/nodeIcon';
import {
  analyzeClipboard,
  regenerateLinkUuids,
  generateLinkUuid,
  flattenBlocks,
  type ParsedBlock,
} from '@/utils/clipboardManager';
import { findBareNodeUuids } from '@/utils/linkSanitization';

// API
import type { Node } from '@/types';
import { getNodeByUuid, updateLinkName } from '@/api/nodes';

// AST infrastructure
import { parseAST } from '@/lib/astBuilder';
import type { ASTDocument } from '@/types/ast';
import {
  astToHtmlCached,
  domToAST,
  normalizeAST,
  getCursorPosition,
  setCursorPosition,
  getContentLength,
  getCaretX,
  getCaretCoordinates,
  getPlainText,
  findOffsetAtXInFirstLine,
  findOffsetAtXInLastLine,
  isTextOnlyChange,
  detectTrigger,
  type ASTRenderContext,
  type ResolvedLink,
  type LinkStatus,
} from '@/lib/astDom';
import {
  splitAtPosition,
  mergeDocuments,
  replaceTriggerWithLink,
  removeTriggerText,
  toggleMark,
  toggleCode,
  getActiveMarks,
  insertText,
  wrapInExternalLink,
} from '@/lib/astMutations';
import type { MarkType } from '@/lib/astMutations';
import { ASTHistory, type HistoryEntry } from '@/lib/astHistory';

// ─── Types ────────────────────────────────────────────────────────

// Task states for cycling with Shift+Enter
export const TASK_STATES = ['todo', 'doing', 'done', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface PastedBlock {
  content: string;
  depth: number;
  children?: PastedBlock[];
}

export interface PastedTable {
  name?: string;
  headers: string[];
  rows: string[][];
}

/**
 * Props interface — identical to the legacy BlockEditor.
 * Block.tsx passes these without modification.
 */
export interface BlockEditorProps {
  nodeId?: number;
  isPage?: boolean;
  nodeUuid?: string;
  content: string;
  onChange: (content: string) => void;
  onAddClass?: (classNodeId: number, keepInline: boolean, className: string) => void;
  queryClassId?: number | null;
  tableClassId?: number | null;
  onAddTag?: (tagNodeId: number, keepInline: boolean, tagName: string) => void;
  onCreateClass?: (name: string, keepInline: boolean) => void;
  onCreateTag?: (name: string, keepInline: boolean) => void;
  onLinkPage?: (pageNode: Node) => void;
  onCreatePageLink?: (name: string) => Promise<string | undefined>;
  onOpenComments?: () => void;
  onAssetUpload?: (assetTypesOrFile?: ('image' | 'audio' | 'file')[] | File) => void;
  onAddProperty?: () => void;
  readOnly?: boolean;
  onEscape?: () => void;
  onNavigateUp?: (caretX?: number) => void;
  onNavigateDown?: (caretX?: number) => void;
  onNavigateLeft?: () => void;
  onNavigateRight?: () => void;
  onExtendSelection?: (direction: 'up' | 'down') => void;
  isTask?: boolean;
  taskState?: TaskState;
  onTaskStateChange?: (newState: TaskState) => void;
  onEnterCreateBlock?: (textBeforeCursor: string, textAfterCursor: string) => void;
  onBackspaceAtStart?: (remainingText: string) => void;
  onDeleteAtEnd?: () => void;
  onIndent?: () => void;
  onOutdent?: () => void;
  onPasteBlocks?: (currentBlockText: string, newBlocks: PastedBlock[]) => void;
  onPasteTable?: (table: PastedTable) => void;
  editorRef?: React.RefObject<HTMLDivElement | null>;
}

// ─── Trigger state ────────────────────────────────────────────────

interface TriggerState {
  isOpen: boolean;
  type: SuggestionType;
  query: string;
  triggerPosition: number;
  position: { top: number; left: number };
}

interface SlashState {
  isOpen: boolean;
  query: string;
  triggerPosition: number;
  position: { top: number; left: number };
}

// ─── Component ────────────────────────────────────────────────────

export function ASTBlockEditor({
  nodeId,
  isPage,
  nodeUuid,
  content,
  onChange,
  onAddClass,
  queryClassId,
  tableClassId,
  onAddTag,
  onCreateClass,
  onCreateTag,
  onLinkPage,
  onCreatePageLink,
  onOpenComments,
  onAssetUpload,
  onAddProperty,
  readOnly = false,
  onEscape,
  onNavigateUp,
  onNavigateDown,
  onNavigateLeft,
  onNavigateRight,
  onExtendSelection,
  isTask = false,
  taskState,
  onTaskStateChange,
  onEnterCreateBlock,
  onBackspaceAtStart,
  onDeleteAtEnd,
  onIndent,
  onOutdent,
  onPasteBlocks,
  onPasteTable,
  editorRef: externalEditorRef,
}: BlockEditorProps) {
  // ─── Refs ──────────────────────────────────────────────────────
  const internalEditorRef = useRef<HTMLDivElement>(null);
  const editorRef = internalEditorRef;
  const initialCursorApplied = useRef(false);
  const lastASTRef = useRef<ASTDocument>([]);
  const isInternalChange = useRef(false);
  const isComposingRef = useRef(false);
  const historyRef = useRef(new ASTHistory());
  const pendingUuidResolutions = useRef(new Set<string>());
  const pendingOnChange = useRef<string | null>(null);
  const rafId = useRef<number>(0);
  // Optimistic link resolution — stores link info for newly inserted links
  // before the API returns them in textLinks
  const pendingLinksRef = useRef(new Map<string, ResolvedLink>());

  // ─── State ─────────────────────────────────────────────────────
  const [selectedPill, setSelectedPill] = useState<HTMLElement | null>(null);
  const [, setIsComposing] = useState(false);
  const [trigger, setTrigger] = useState<TriggerState>({
    isOpen: false,
    type: 'type',
    query: '',
    triggerPosition: 0,
    position: { top: 0, left: 0 },
  });
  const [slashCommand, setSlashCommand] = useState<SlashState>({
    isOpen: false,
    query: '',
    triggerPosition: 0,
    position: { top: 0, left: 0 },
  });
  const [linkNameDialog, setLinkNameDialog] = useState<{
    isOpen: boolean;
    linkUuid: string;
    currentName: string | null;
    nodeId: number;
    position: { top: number; left: number };
  } | null>(null);
  const linkNameDialogRef = useRef<HTMLDivElement>(null);
  const [editorContextMenu, setEditorContextMenu] = useState<{
    position: { x: number; y: number };
    linkUuid: string;
    targetNodeId: number;
    isPage: boolean;
  } | null>(null);

  // ─── Selection toolbar state ───────────────────────────────────
  const [selectionToolbar, setSelectionToolbar] = useState<{
    visible: boolean;
    position: { top: number; left: number };
    start: number;
    end: number;
    activeMarks: Set<MarkType>;
  }>({ visible: false, position: { top: 0, left: 0 }, start: 0, end: 0, activeMarks: new Set() });

  // ─── Query client ──────────────────────────────────────────────
  const queryClient = useQueryClient();
  const { openNode, addSidebarCard } = useNodesStore();

  // ─── Batched onChange via requestAnimationFrame ────────────────
  const flushOnChange = useCallback(() => {
    if (pendingOnChange.current !== null) {
      onChange(pendingOnChange.current);
      pendingOnChange.current = null;
    }
  }, [onChange]);

  const scheduleOnChange = useCallback((serialized: string) => {
    pendingOnChange.current = serialized;
    cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(flushOnChange);
  }, [flushOnChange]);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafId.current);
      // Flush any pending change synchronously on unmount
      if (pendingOnChange.current !== null) {
        onChange(pendingOnChange.current);
        pendingOnChange.current = null;
      }
    };
  }, [onChange]);

  // ─── Selection store ───────────────────────────────────────────
  const pendingSelection = usePendingSelectionForBlock(nodeId ?? -1);
  const { clearPendingSelection } = useEditorSelectionActions();

  // ─── Parse content to AST ──────────────────────────────────────
  const ast = useMemo(() => parseAST(content), [content]);

  // Keep lastASTRef in sync
  useEffect(() => {
    if (!isInternalChange.current) {
      lastASTRef.current = ast;
    }
  }, [ast]);

  // ─── Data hooks ────────────────────────────────────────────────
  // Extract link IDs from AST (not from string regex)
  const linkIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (nodes: ASTDocument) => {
      for (const para of nodes) {
        for (const node of para.children) {
          if (node.type === 'node_link') {
            ids.push(node.link_id);
          } else if ('children' in node) {
            // Walk children of marks
            walkInlines((node as { children: typeof para.children }).children);
          }
        }
      }
    };
    const walkInlines = (nodes: typeof ast[0]['children']) => {
      for (const node of nodes) {
        if (node.type === 'node_link') {
          ids.push(node.link_id);
        } else if ('children' in node) {
          walkInlines((node as { children: typeof nodes }).children);
        }
      }
    };
    walk(ast);
    return ids;
  }, [ast]);

  const { data: allNodes, isFetched: allNodesFetched } = useNodes(linkIds.length > 0 ? {} : null);
  const { data: allClasses } = useClasses();
  const { data: textLinks, isFetched: textLinksFetched } = useTextLinks(nodeId ?? null);

  // Build lookup maps
  const tagTargetIds = useMemo(() => {
    const set = new Set<number>();
    if (textLinks) {
      for (const link of textLinks) {
        if (link.is_tag) set.add(link.target_node_id);
      }
    }
    return set;
  }, [textLinks]);

  const linkCustomNames = useMemo(() => {
    const map = new Map<string, string | null>();
    if (textLinks) {
      for (const link of textLinks) {
        if (link.uuid && link.name) {
          map.set(link.uuid, link.name);
        }
      }
    }
    return map;
  }, [textLinks]);

  // Map of all nodes by ID for direct node-ID-based link resolution
  const allNodesMap = useMemo(() => {
    if (!allNodes || !allNodesFetched) return new Map<number, Node>();
    return new Map(allNodes.map(n => [n.id, n]));
  }, [allNodes, allNodesFetched]);

  // Map of link UUID → resolved info for display
  const linkResolveMap = useMemo(() => {
    const map = new Map<string, ResolvedLink>();
    if (allNodesFetched && allNodes && textLinks) {
      for (const tl of textLinks) {
        if (!tl.uuid) continue;
        const target = allNodesMap.get(tl.target_node_id);
        const linkStatus: LinkStatus = target ? 'valid' : 'broken';

        if (!target) {
          // Broken link — target node deleted/missing
          map.set(tl.uuid, {
            displayText: tl.name || 'Deleted',
            targetName: tl.name || 'Deleted',
            isTag: false,
            effectiveIcon: null,
            customLabel: tl.name || null,
            linkStatus: 'broken',
          });
          continue;
        }

        const customLabel = tl.name || null;
        const targetName = nodeNameToText(target.name) || 'Untitled';
        const displayText = customLabel || targetName;
        const effectiveIcon = getEffectiveIcon(target, allClasses ?? []);
        const isTag = tagTargetIds.has(target.id);

        map.set(tl.uuid, { displayText, targetName, isTag, effectiveIcon: effectiveIcon ?? null, customLabel, linkStatus });
      }
    }
    return map;
  }, [allNodes, allNodesFetched, allNodesMap, allClasses, textLinks, tagTargetIds]);

  // Clean up pending links once they appear in the real resolve map
  useEffect(() => {
    for (const key of pendingLinksRef.current.keys()) {
      if (linkResolveMap.has(key)) {
        pendingLinksRef.current.delete(key);
      }
    }
  }, [linkResolveMap]);

  // Whether link resolution data has fully loaded (not just placeholder)
  const linkDataLoaded = linkIds.length === 0 || (textLinksFetched && allNodesFetched);

  // ─── Render context ────────────────────────────────────────────
  const renderCtx = useMemo<ASTRenderContext>(() => ({
    resolveLink: (linkId: string, refType: 'node' | 'class'): ResolvedLink | null => {
      // 1. Direct lookup by link UUID (matches textLinks.uuid)
      const resolved = linkResolveMap.get(linkId);
      if (resolved) return resolved;

      // 2. Compound format "nodeId:uuid" — try the UUID part
      const colonIdx = linkId.indexOf(':');
      if (colonIdx > 0) {
        const uuidPart = linkId.substring(colonIdx + 1);
        const byUuid = linkResolveMap.get(uuidPart);
        if (byUuid) return byUuid;
      }

      // 3. Check optimistic pending links
      const pending = pendingLinksRef.current.get(linkId);
      if (pending) return pending;

      // 4. Try as numeric node ID (old format where link_id = "42")
      //    This covers existing links stored before the UUID system
      const numericPart = colonIdx > 0 ? linkId.substring(0, colonIdx) : linkId;
      const numericId = parseInt(numericPart, 10);
      if (!isNaN(numericId) && allNodesFetched && refType === 'node') {
        const node = allNodesMap.get(numericId);
        if (node) {
          const name = nodeNameToText(node.name) || 'Untitled';
          return {
            displayText: name,
            targetName: name,
            isTag: tagTargetIds.has(node.id),
            effectiveIcon: getEffectiveIcon(node, allClasses ?? []) ?? null,
            customLabel: null,
            linkStatus: 'valid',
          };
        }
      }
      // For class refs, link_id is the class node ID
      if (!isNaN(numericId) && allNodesFetched && refType === 'class') {
        const node = allNodesMap.get(numericId);
        if (node) {
          const name = nodeNameToText(node.name) || 'Untitled';
          return {
            displayText: name,
            targetName: name,
            isTag: false,
            effectiveIcon: null,
            customLabel: null,
            linkStatus: 'valid',
          };
        }
      }

      // 5. Data still loading — show placeholder
      if (!linkDataLoaded) {
        return { displayText: '…', targetName: '…', isTag: false, effectiveIcon: null, customLabel: null, linkStatus: 'valid' };
      }
      return null;
    },
  }), [linkResolveMap, linkDataLoaded, allNodesMap, allNodesFetched, allClasses, tagTargetIds]);

  // ─── Sync external ref ────────────────────────────────────────
  useEffect(() => {
    if (externalEditorRef && internalEditorRef.current) {
      (externalEditorRef as React.MutableRefObject<HTMLDivElement | null>).current = internalEditorRef.current;
    }
  }, [externalEditorRef]);

  // ─── Render AST to DOM ─────────────────────────────────────────
  const renderToDOM = useCallback((astDoc: ASTDocument) => {
    if (!editorRef.current) return;
    const html = astToHtmlCached(astDoc, renderCtx);
    editorRef.current.innerHTML = html || '<br>';
  }, [renderCtx]);

  // ─── Content sync effect ───────────────────────────────────────
  useEffect(() => {
    if (!editorRef.current) return;

    // Skip if this is an internal change (user typing)
    if (isInternalChange.current) {
      isInternalChange.current = false;
      return;
    }

    const editorIsFocused = document.activeElement === editorRef.current;
    let savedPos: number | undefined;
    if (initialCursorApplied.current && editorIsFocused) {
      savedPos = getCursorPosition(editorRef.current);
    }

    renderToDOM(ast);
    lastASTRef.current = ast;

    // Focus and cursor positioning
    if (!initialCursorApplied.current && document.activeElement !== editorRef.current) {
      editorRef.current.focus();
    }

    if (!initialCursorApplied.current && !pendingSelection) {
      const range = document.createRange();
      range.selectNodeContents(editorRef.current);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      initialCursorApplied.current = true;
    } else if (pendingSelection && !initialCursorApplied.current) {
      initialCursorApplied.current = true;
    } else if (savedPos !== undefined && editorIsFocused) {
      setCursorPosition(editorRef.current, savedPos);
    }
  }, [ast, renderToDOM, pendingSelection]);

  // Re-render when link names become available
  const resolveMapSize = linkResolveMap.size;
  useEffect(() => {
    if (!editorRef.current || !initialCursorApplied.current) return;
    const editorIsFocused = document.activeElement === editorRef.current;
    let savedPos: number | undefined;
    if (editorIsFocused) {
      savedPos = getCursorPosition(editorRef.current);
    }
    renderToDOM(lastASTRef.current);
    if (savedPos !== undefined && editorIsFocused) {
      setCursorPosition(editorRef.current, savedPos);
    }
  }, [resolveMapSize, renderToDOM]);

  // ─── Pending selection restoration ─────────────────────────────
  useLayoutEffect(() => {
    if (!pendingSelection || !editorRef.current) return;
    if (pendingSelection.anchorBlockId !== nodeId) return;

    if (document.activeElement !== editorRef.current) {
      editorRef.current.focus();
    }

    if (pendingSelection.caretX !== undefined) {
      const contentLen = getContentLength(editorRef.current);
      let targetOffset: number;
      if (pendingSelection.anchorOffset === 0) {
        targetOffset = findOffsetAtXInFirstLine(editorRef.current, pendingSelection.caretX);
      } else if (pendingSelection.anchorOffset >= contentLen) {
        targetOffset = findOffsetAtXInLastLine(editorRef.current, pendingSelection.caretX);
      } else {
        targetOffset = pendingSelection.anchorOffset;
      }
      setCursorPosition(editorRef.current, targetOffset);
    } else {
      setCursorPosition(editorRef.current, pendingSelection.anchorOffset);
    }

    clearPendingSelection();
  }, [pendingSelection, nodeId, clearPendingSelection]);

  // ─── Commit AST change ─────────────────────────────────────────
  /**
   * Apply a new AST, re-render DOM, notify parent via onChange.
   */
  const commitAST = useCallback((
    newAST: ASTDocument,
    cursorOffset?: number,
    pushHistory = true,
  ) => {
    if (pushHistory) {
      const curPos = editorRef.current ? getCursorPosition(editorRef.current) : 0;
      historyRef.current.push({ ast: lastASTRef.current, cursorOffset: curPos }, 500);
    }

    lastASTRef.current = newAST;
    isInternalChange.current = true;

    // Serialize AST to string for the parent's onChange (RAF-batched)
    const serialized = JSON.stringify(newAST);
    scheduleOnChange(serialized);

    // Re-render DOM
    renderToDOM(newAST);

    // Restore cursor
    if (cursorOffset !== undefined && editorRef.current) {
      setTimeout(() => {
        if (editorRef.current) {
          editorRef.current.focus();
          setCursorPosition(editorRef.current, cursorOffset);
        }
      }, 0);
    }
  }, [scheduleOnChange, renderToDOM]);

  // ─── Bare UUID resolution ──────────────────────────────────────
  const resolveBareUuids = useCallback(async (text: string) => {
    const bareUuids = findBareNodeUuids(text);
    if (bareUuids.length === 0) return;

    const newUuids = bareUuids.filter(u => !pendingUuidResolutions.current.has(u.uuid));
    if (newUuids.length === 0) return;

    for (const u of newUuids) pendingUuidResolutions.current.add(u.uuid);

    const resolved = await Promise.allSettled(
      newUuids.map(async u => {
        try {
          const node = await getNodeByUuid(u.uuid);
          return { uuid: u.uuid, nodeId: node.id, node };
        } catch {
          return null;
        }
      }),
    );

    for (const u of newUuids) pendingUuidResolutions.current.delete(u.uuid);

    // For bare UUIDs, we'd need to convert them to proper links in the AST.
    // For now, trigger through the legacy string path (content already serialized).
    // This is a passthrough — bare UUID resolution is rare.
    const replacements = new Map<string, { replacement: string; node: Node }>();
    for (const result of resolved) {
      if (result.status === 'fulfilled' && result.value) {
        const { uuid, nodeId: nId, node } = result.value;
        const linkUuid = generateLinkUuid();
        replacements.set(uuid, { replacement: `[[${nId}:${linkUuid}]]`, node });
      }
    }
    if (replacements.size === 0) return;

    // Re-read current serialized content and apply replacements
    let currentStr = JSON.stringify(lastASTRef.current);
    const currentBare = findBareNodeUuids(currentStr);
    const toReplace = currentBare
      .filter(u => replacements.has(u.uuid))
      .sort((a, b) => b.start - a.start);

    for (const u of toReplace) {
      const { node } = replacements.get(u.uuid)!;
      onLinkPage?.(node);
    }
    // Bare UUID resolution is a legacy edge case. The AST path doesn't use string UUIDs.
  }, [onLinkPage]);

  // ─── Input handler ─────────────────────────────────────────────
  const handleInput = useCallback(() => {
    if (!editorRef.current || isComposingRef.current) return;

    // Extract AST from the live DOM
    const rawAST = domToAST(editorRef.current);
    const newAST = normalizeAST(rawAST);

    // Check if AST actually changed
    const newStr = JSON.stringify(newAST);
    const oldStr = JSON.stringify(lastASTRef.current);
    if (newStr === oldStr) return;

    // For text-only changes (typing), skip full DOM rebuild —
    // the browser already has the right DOM from the user's input.
    const textOnly = isTextOnlyChange(lastASTRef.current, newAST);

    // Push history with debounce for typing
    const curPos = getCursorPosition(editorRef.current);
    historyRef.current.push({ ast: lastASTRef.current, cursorOffset: curPos }, 500);

    lastASTRef.current = newAST;
    isInternalChange.current = true;
    scheduleOnChange(newStr);

    // Only rebuild DOM if structural changes happened (not pure typing)
    if (!textOnly) {
      renderToDOM(newAST);
      setCursorPosition(editorRef.current, curPos);
    }

    // Check triggers
    checkTriggers();

    // Check for bare UUIDs
    const plainText = getPlainText(editorRef.current);
    resolveBareUuids(plainText);
  }, [scheduleOnChange, resolveBareUuids, renderToDOM]);

  // ─── Trigger system ────────────────────────────────────────────
  const checkTriggers = useCallback(() => {
    if (readOnly || !editorRef.current) return;

    const cursorPos = getCursorPosition(editorRef.current);
    if (cursorPos === 0) {
      setTrigger(prev => (prev.isOpen ? { ...prev, isOpen: false } : prev));
      setSlashCommand(prev => (prev.isOpen ? { ...prev, isOpen: false } : prev));
      return;
    }

    // Pure function: detect trigger from plain text + cursor position
    const plainText = getPlainText(editorRef.current);
    const match = detectTrigger(plainText, cursorPos);

    if (!match) {
      setTrigger(prev => (prev.isOpen ? { ...prev, isOpen: false } : prev));
      setSlashCommand(prev => (prev.isOpen ? { ...prev, isOpen: false } : prev));
      return;
    }

    const coords = getCaretCoordinates(editorRef.current);

    if (match.type === 'slash') {
      setSlashCommand({ isOpen: true, query: match.query, triggerPosition: match.triggerOffset, position: coords });
      setTrigger(prev => (prev.isOpen ? { ...prev, isOpen: false } : prev));
    } else {
      setTrigger({
        isOpen: true,
        type: match.type,
        query: match.query,
        triggerPosition: match.triggerOffset,
        position: coords,
      });
      setSlashCommand(prev => (prev.isOpen ? { ...prev, isOpen: false } : prev));
    }
  }, [readOnly]);

  // ─── Selection change handler ──────────────────────────────────
  const updateSelectionToolbar = useCallback(() => {
    if (readOnly || !editorRef.current) {
      setSelectionToolbar(prev => prev.visible ? { ...prev, visible: false } : prev);
      return;
    }

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelectionToolbar(prev => prev.visible ? { ...prev, visible: false } : prev);
      return;
    }

    // Check if selection is within our editor
    const range = sel.getRangeAt(0);
    if (!editorRef.current.contains(range.commonAncestorContainer)) {
      setSelectionToolbar(prev => prev.visible ? { ...prev, visible: false } : prev);
      return;
    }

    // Get selection bounds
    const rect = range.getBoundingClientRect();
    if (rect.width === 0) {
      setSelectionToolbar(prev => prev.visible ? { ...prev, visible: false } : prev);
      return;
    }

    // Get selection range in logical characters
    // Clone the range to avoid modifying the actual selection
    const clonedRange = range.cloneRange();
    
    // Calculate start position
    clonedRange.collapse(true);
    const tempSel = window.getSelection();
    tempSel?.removeAllRanges();
    tempSel?.addRange(clonedRange);
    const start = getCursorPosition(editorRef.current);
    
    // Calculate end position
    const endRange = range.cloneRange();
    endRange.collapse(false);
    tempSel?.removeAllRanges();
    tempSel?.addRange(endRange);
    const end = getCursorPosition(editorRef.current);
    
    // Restore original selection
    tempSel?.removeAllRanges();
    tempSel?.addRange(range);

    const actualStart = Math.min(start, end);
    const actualEnd = Math.max(start, end);

    if (actualEnd <= actualStart) {
      setSelectionToolbar(prev => prev.visible ? { ...prev, visible: false } : prev);
      return;
    }

    // Get position for toolbar (below selection, at start)
    const editorRect = editorRef.current.getBoundingClientRect();
    
    const activeMarks = getActiveMarks(lastASTRef.current, actualStart, actualEnd);

    setSelectionToolbar({
      visible: true,
      position: {
        top: rect.bottom - editorRect.top + 4,
        left: rect.left - editorRect.left,
      },
      start: actualStart,
      end: actualEnd,
      activeMarks,
    });
  }, [readOnly]);

  // Handle mouse up to show toolbar after selection
  const handleMouseUp = useCallback(() => {
    // Small delay to let selection finalize
    setTimeout(updateSelectionToolbar, 10);
  }, [updateSelectionToolbar]);

  // Handle keyup for keyboard selection (Shift+Arrow)
  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.shiftKey && (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')) {
      setTimeout(updateSelectionToolbar, 10);
    }
  }, [updateSelectionToolbar]);

  // Hide toolbar on any input or when selection collapses
  useEffect(() => {
    const handleSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setSelectionToolbar(prev => prev.visible ? { ...prev, visible: false } : prev);
      }
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, []);

  // ─── Toolbar formatting handlers ───────────────────────────────
  const handleToolbarBold = useCallback(() => {
    if (!selectionToolbar.visible) return;
    const result = toggleMark(lastASTRef.current, selectionToolbar.start, selectionToolbar.end, 'strong');
    commitAST(result.ast, selectionToolbar.end);
    setSelectionToolbar(prev => ({ ...prev, visible: false }));
  }, [selectionToolbar, commitAST]);

  const handleToolbarItalic = useCallback(() => {
    if (!selectionToolbar.visible) return;
    const result = toggleMark(lastASTRef.current, selectionToolbar.start, selectionToolbar.end, 'em');
    commitAST(result.ast, selectionToolbar.end);
    setSelectionToolbar(prev => ({ ...prev, visible: false }));
  }, [selectionToolbar, commitAST]);

  const handleToolbarCode = useCallback(() => {
    if (!selectionToolbar.visible) return;
    const result = toggleCode(lastASTRef.current, selectionToolbar.start, selectionToolbar.end);
    commitAST(result.ast, selectionToolbar.end);
    setSelectionToolbar(prev => ({ ...prev, visible: false }));
  }, [selectionToolbar, commitAST]);

  const handleToolbarStrikethrough = useCallback(() => {
    if (!selectionToolbar.visible) return;
    const result = toggleMark(lastASTRef.current, selectionToolbar.start, selectionToolbar.end, 'strikethrough');
    commitAST(result.ast, selectionToolbar.end);
    setSelectionToolbar(prev => ({ ...prev, visible: false }));
  }, [selectionToolbar, commitAST]);

  const handleToolbarUnderline = useCallback(() => {
    if (!selectionToolbar.visible) return;
    const result = toggleMark(lastASTRef.current, selectionToolbar.start, selectionToolbar.end, 'underline');
    commitAST(result.ast, selectionToolbar.end);
    setSelectionToolbar(prev => ({ ...prev, visible: false }));
  }, [selectionToolbar, commitAST]);

  const handleToolbarLink = useCallback((url: string) => {
    if (!selectionToolbar.visible) return;
    const result = wrapInExternalLink(lastASTRef.current, selectionToolbar.start, selectionToolbar.end, url);
    commitAST(result.ast, selectionToolbar.end);
    setSelectionToolbar(prev => ({ ...prev, visible: false }));
  }, [selectionToolbar, commitAST]);

  // ─── Key handler ───────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!editorRef.current) return;

    const cursorPos = getCursorPosition(editorRef.current);
    const contentLen = getContentLength(editorRef.current);

    // ── Pill deletion ──
    if (selectedPill && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
      selectedPill.remove();
      setSelectedPill(null);
      // Re-extract AST from DOM
      const newAST = normalizeAST(domToAST(editorRef.current));
      commitAST(newAST);
      return;
    }

    // Clear selected pill on typing
    if (selectedPill && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      selectedPill.classList.remove('inline-node-link--selected', 'link-pill--selected');
      setSelectedPill(null);
    }

    // ── Undo/Redo ──
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      const curEntry: HistoryEntry = { ast: lastASTRef.current, cursorOffset: cursorPos };
      const entry = historyRef.current.undo(curEntry);
      if (entry) {
        commitAST(entry.ast, entry.cursorOffset, false);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      const curEntry: HistoryEntry = { ast: lastASTRef.current, cursorOffset: cursorPos };
      const entry = historyRef.current.redo(curEntry);
      if (entry) {
        commitAST(entry.ast, entry.cursorOffset, false);
      }
      return;
    }

    // ── Inline formatting ──
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && editorRef.current) {
        const start = getCursorPosition(editorRef.current);
        // Get end position by temporarily collapsing to focus
        const range = sel.getRangeAt(0);
        const savedStart = { node: range.startContainer, offset: range.startOffset };
        const tempRange = document.createRange();
        tempRange.setStart(range.endContainer, range.endOffset);
        tempRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(tempRange);
        const end = getCursorPosition(editorRef.current);
        // Restore selection
        const restoreRange = document.createRange();
        restoreRange.setStart(savedStart.node, savedStart.offset);
        restoreRange.setEnd(range.endContainer, range.endOffset);
        sel.removeAllRanges();
        sel.addRange(restoreRange);

        const actualStart = Math.min(start, end);
        const actualEnd = Math.max(start, end);

        if (e.key === 'b') {
          e.preventDefault();
          const result = toggleMark(lastASTRef.current, actualStart, actualEnd, 'strong');
          commitAST(result.ast, actualEnd);
          return;
        }
        if (e.key === 'i') {
          e.preventDefault();
          const result = toggleMark(lastASTRef.current, actualStart, actualEnd, 'em');
          commitAST(result.ast, actualEnd);
          return;
        }
        if (e.key === 'u') {
          e.preventDefault();
          const result = toggleMark(lastASTRef.current, actualStart, actualEnd, 'underline');
          commitAST(result.ast, actualEnd);
          return;
        }
        if (e.key === '`') {
          e.preventDefault();
          const result = toggleCode(lastASTRef.current, actualStart, actualEnd);
          commitAST(result.ast, actualEnd);
          return;
        }
      }
    }

    // ── Shift+Enter: task state cycling ──
    if (e.shiftKey && e.key === 'Enter' && isTask && onTaskStateChange) {
      e.preventDefault();
      const currentIndex = taskState ? TASK_STATES.indexOf(taskState) : -1;
      const nextIndex = (currentIndex + 1) % TASK_STATES.length;
      onTaskStateChange(TASK_STATES[nextIndex]);
      return;
    }

    // ── Enter: create new block ──
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (trigger.isOpen || slashCommand.isOpen) return;
      e.preventDefault();
      if (onEnterCreateBlock) {
        const [before, after] = splitAtPosition(lastASTRef.current, cursorPos);
        onEnterCreateBlock(JSON.stringify(before), JSON.stringify(after));
      }
      return;
    }

    // ── Backspace at start ──
    if (e.key === 'Backspace' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (cursorPos === 0 && onBackspaceAtStart) {
        e.preventDefault();
        onBackspaceAtStart(JSON.stringify(lastASTRef.current));
        return;
      }
    }

    // ── Delete at end ──
    if (e.key === 'Delete' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (cursorPos === contentLen && onDeleteAtEnd) {
        e.preventDefault();
        onDeleteAtEnd();
        return;
      }
    }

    // ── Ctrl+C with no selection: copy block link ──
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      const sel = window.getSelection();
      if (sel?.isCollapsed && nodeUuid) {
        e.preventDefault();
        navigator.clipboard.writeText(`((${nodeUuid}))`);
        return;
      }
    }

    // ── Escape ──
    if (e.key === 'Escape') {
      e.preventDefault();
      editorRef.current.blur();
      onEscape?.();
      return;
    }

    // ── Tab / Shift+Tab ──
    if (e.key === 'Tab') {
      if (slashCommand.isOpen) return;
      e.preventDefault();
      if (e.shiftKey) {
        onOutdent?.();
      } else {
        onIndent?.();
      }
      return;
    }

    // ── Shift+Arrow: extend selection ──
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      onExtendSelection?.(e.key === 'ArrowUp' ? 'up' : 'down');
      return;
    }

    // ── Arrow navigation around pills ──
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      handleArrowNavigation(e);
    }

    // ── Arrow up/down navigation ──
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      const caretXVal = getCaretX();

      if (e.key === 'ArrowUp') {
        if (cursorPos === 0) {
          e.preventDefault();
          onNavigateUp?.(caretXVal);
          return;
        }
        const rangeRect = range.getBoundingClientRect();
        const editorRect = editorRef.current.getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(editorRef.current).lineHeight) || 24;
        const cursorTop = rangeRect.height > 0 ? rangeRect.top : rangeRect.bottom;
        if (cursorTop - editorRect.top < lineHeight * 1.5) {
          e.preventDefault();
          onNavigateUp?.(caretXVal);
          return;
        }
      } else {
        if (cursorPos === contentLen) {
          e.preventDefault();
          onNavigateDown?.(caretXVal);
          return;
        }
        const rangeRect = range.getBoundingClientRect();
        const editorRect = editorRef.current.getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(editorRef.current).lineHeight) || 24;
        const cursorBottom = rangeRect.height > 0 ? rangeRect.bottom : rangeRect.top;
        if (editorRect.bottom - cursorBottom < lineHeight * 1.5) {
          e.preventDefault();
          onNavigateDown?.(caretXVal);
          return;
        }
      }
    }
  }, [
    selectedPill, onChange, onEscape, onNavigateUp, onNavigateDown,
    onExtendSelection, isTask, taskState, onTaskStateChange,
    onEnterCreateBlock, onBackspaceAtStart, onDeleteAtEnd,
    onIndent, onOutdent, trigger.isOpen, slashCommand.isOpen,
    nodeUuid, commitAST,
  ]);

  // ─── Arrow navigation around pills ────────────────────────────
  const handleArrowNavigation = useCallback((e: React.KeyboardEvent) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const direction = e.key === 'ArrowLeft' ? 'left' : 'right';

    // If a pill is selected, move cursor past it
    if (selectedPill) {
      e.preventDefault();
      selectedPill.classList.remove('inline-node-link--selected', 'link-pill--selected');
      setSelectedPill(null);

      const parent = selectedPill.parentNode;
      if (parent) {
        const newRange = document.createRange();
        const index = Array.from(parent.childNodes).indexOf(selectedPill as ChildNode);
        if (direction === 'left') {
          const prevNode = selectedPill.previousSibling;
          if (prevNode && prevNode.nodeType === globalThis.Node.TEXT_NODE) {
            newRange.setStart(prevNode, prevNode.textContent?.length || 0);
          } else {
            newRange.setStart(parent, index);
          }
        } else {
          const nextNode = selectedPill.nextSibling;
          if (nextNode && nextNode.nodeType === globalThis.Node.TEXT_NODE) {
            newRange.setStart(nextNode, 0);
          } else {
            newRange.setStart(parent, index + 1);
          }
        }
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
      }
      return;
    }

    // Check if cursor is adjacent to a pill
    let adjacentPill: HTMLElement | null = null;

    if (direction === 'left') {
      const container = range.startContainer;
      if (container.nodeType === globalThis.Node.TEXT_NODE && range.startOffset === 0) {
        let prev: globalThis.Node | null = container.previousSibling;
        if (!prev && container.parentNode !== editorRef.current) {
          prev = container.parentNode?.previousSibling || null;
        }
        if (prev && isPillEl(prev as HTMLElement)) {
          adjacentPill = prev as HTMLElement;
        }
      } else if (container.nodeType === globalThis.Node.TEXT_NODE) {
        const text = container.textContent || '';
        if (text === '\u200B' && range.startOffset <= 1) {
          const prev = container.previousSibling;
          if (prev && isPillEl(prev as HTMLElement)) {
            adjacentPill = prev as HTMLElement;
          }
        }
      }
    } else {
      const container = range.startContainer;
      if (container.nodeType === globalThis.Node.TEXT_NODE && range.startOffset === (container.textContent?.length || 0)) {
        const next = container.nextSibling;
        if (next && isPillEl(next as HTMLElement)) {
          adjacentPill = next as HTMLElement;
        }
      } else if (container === editorRef.current) {
        const childIndex = range.startOffset;
        const child = container.childNodes[childIndex];
        if (child && isPillEl(child as HTMLElement)) {
          adjacentPill = child as HTMLElement;
        }
      }
    }

    if (adjacentPill) {
      e.preventDefault();
      adjacentPill.classList.add(
        adjacentPill.classList.contains('inline-node-link')
          ? 'inline-node-link--selected'
          : 'link-pill--selected',
      );
      setSelectedPill(adjacentPill);
      return;
    }

    // Edge navigation for table cells
    if (!editorRef.current) return;
    const contentLen = getContentLength(editorRef.current);
    const cursorPos = getCursorPosition(editorRef.current);

    if (direction === 'left' && cursorPos === 0 && onNavigateLeft) {
      e.preventDefault();
      onNavigateLeft();
    } else if (direction === 'right' && cursorPos === contentLen && onNavigateRight) {
      e.preventDefault();
      onNavigateRight();
    }
  }, [selectedPill, onNavigateLeft, onNavigateRight]);

  // ─── Suggestion popup handlers ─────────────────────────────────
  const handleSelect = useCallback((node: Node, keepInline: boolean) => {
    if (!editorRef.current) return;

    const cursorPos = getCursorPosition(editorRef.current);

    if (trigger.type === 'link') {
      const linkUuid = generateLinkUuid();
      // Use "nodeId:linkUuid" format so backend can parse the target node ID
      const compoundLinkId = `${node.id}:${linkUuid}`;
      const result = replaceTriggerWithLink(
        lastASTRef.current,
        trigger.triggerPosition,
        cursorPos,
        compoundLinkId,
        'node',
      );
      // Also notify parent about the link
      onLinkPage?.(node);

      // Store optimistic link info so the pill renders immediately
      const displayText = nodeNameToText(node.name) || 'Untitled';
      const effectiveIcon = getEffectiveIcon(node, allClasses ?? []);
      pendingLinksRef.current.set(compoundLinkId, {
        displayText,
        targetName: displayText,
        isTag: false,
        effectiveIcon: effectiveIcon ?? null,
        customLabel: null,
        linkStatus: 'valid',
      });

      commitAST(result.ast, result.cursorOffset);
    } else if (trigger.type === 'tag' && keepInline) {
      const linkUuid = generateLinkUuid();
      const compoundLinkId = `${node.id}:${linkUuid}`;
      const result = replaceTriggerWithLink(
        lastASTRef.current,
        trigger.triggerPosition,
        cursorPos,
        compoundLinkId,
        'node',
      );
      // Store optimistic tag link info
      const displayText = nodeNameToText(node.name) || 'Untitled';
      pendingLinksRef.current.set(compoundLinkId, {
        displayText,
        targetName: displayText,
        isTag: true,
        effectiveIcon: null,
        customLabel: null,
        linkStatus: 'valid',
      });
      onAddTag?.(node.id, keepInline, node.name || '');
      commitAST(result.ast, result.cursorOffset);
    } else if (trigger.type === 'type' && keepInline) {
      const linkId = String(node.id);
      const result = replaceTriggerWithLink(
        lastASTRef.current,
        trigger.triggerPosition,
        cursorPos,
        linkId,
        'class',
      );
      // Store optimistic class link info
      const displayText = nodeNameToText(node.name) || 'Untitled';
      pendingLinksRef.current.set(linkId, {
        displayText,
        targetName: displayText,
        isTag: false,
        effectiveIcon: null,
        customLabel: null,
        linkStatus: 'valid',
      });
      onAddClass?.(node.id, keepInline, node.name || '');
      commitAST(result.ast, result.cursorOffset);
    } else {
      // Non-inline: remove trigger text, add as property
      const cleaned = removeTriggerText(lastASTRef.current, trigger.triggerPosition, cursorPos);
      if (trigger.type === 'type' && onAddClass) {
        onAddClass(node.id, keepInline, node.name || '');
      } else if (trigger.type === 'tag' && onAddTag) {
        onAddTag(node.id, keepInline, node.name || '');
      }
      commitAST(cleaned, trigger.triggerPosition);
    }

    setTrigger(prev => ({ ...prev, isOpen: false }));
  }, [trigger, commitAST, onAddClass, onAddTag, onLinkPage, allClasses]);

  const handleCreate = useCallback(async (name: string, keepInline: boolean) => {
    if (!editorRef.current) return;

    const cursorPos = getCursorPosition(editorRef.current);

    if (trigger.type === 'link') {
      const newPageId = await onCreatePageLink?.(name);
      if (newPageId) {
        const linkUuid = generateLinkUuid();
        const compoundLinkId = `${newPageId}:${linkUuid}`;
        const result = replaceTriggerWithLink(
          lastASTRef.current,
          trigger.triggerPosition,
          cursorPos,
          compoundLinkId,
          'node',
        );
        // Store optimistic link info for the newly created page
        pendingLinksRef.current.set(compoundLinkId, {
          displayText: name || 'Untitled',
          targetName: name || 'Untitled',
          isTag: false,
          effectiveIcon: null,
          customLabel: null,
          linkStatus: 'valid',
        });
        commitAST(result.ast, result.cursorOffset);
      } else {
        const cleaned = removeTriggerText(lastASTRef.current, trigger.triggerPosition, cursorPos);
        commitAST(cleaned, trigger.triggerPosition);
      }
    } else if (keepInline) {
      // For inline create, just remove trigger and create the class/tag
      const cleaned = removeTriggerText(lastASTRef.current, trigger.triggerPosition, cursorPos);
      commitAST(cleaned, trigger.triggerPosition);
      if (trigger.type === 'type' && onCreateClass) onCreateClass(name, keepInline);
      else if (trigger.type === 'tag' && onCreateTag) onCreateTag(name, keepInline);
    } else {
      const cleaned = removeTriggerText(lastASTRef.current, trigger.triggerPosition, cursorPos);
      commitAST(cleaned, trigger.triggerPosition);
      if (trigger.type === 'type' && onCreateClass) onCreateClass(name, keepInline);
      else if (trigger.type === 'tag' && onCreateTag) onCreateTag(name, keepInline);
    }

    setTrigger(prev => ({ ...prev, isOpen: false }));
  }, [trigger, commitAST, onCreatePageLink, onCreateClass, onCreateTag]);

  const handleDatePageSelect = useCallback((_pageId: string, _pageName: string) => {
    if (!editorRef.current) return;
    const cursorPos = getCursorPosition(editorRef.current);
    const linkUuid = generateLinkUuid();
    const compoundLinkId = `${_pageId}:${linkUuid}`;
    const result = replaceTriggerWithLink(
      lastASTRef.current,
      trigger.triggerPosition,
      cursorPos,
      compoundLinkId,
      'node',
    );
    // Store optimistic link info for date page
    pendingLinksRef.current.set(compoundLinkId, {
      displayText: _pageName || 'Untitled',
      targetName: _pageName || 'Untitled',
      isTag: false,
      effectiveIcon: null,
      customLabel: null,
      linkStatus: 'valid',
    });
    commitAST(result.ast, result.cursorOffset);
    setTrigger(prev => ({ ...prev, isOpen: false }));
  }, [trigger, commitAST]);

  const handleClose = useCallback(() => {
    setTrigger(prev => ({ ...prev, isOpen: false }));
  }, []);

  // ─── Slash command handlers ────────────────────────────────────
  const handleSlashCommandSelect = useCallback((command: string) => {
    if (!editorRef.current) return;

    const cursorPos = getCursorPosition(editorRef.current);

    // Remove slash + query text
    const cleaned = removeTriggerText(lastASTRef.current, slashCommand.triggerPosition, cursorPos);

    if (command === 'link') {
      // Insert [[ trigger text
      const { ast: withTrigger, cursorOffset } = insertText(
        cleaned, slashCommand.triggerPosition, '[[',
      );
      commitAST(withTrigger, cursorOffset);
      setTimeout(() => checkTriggers(), 0);
      setSlashCommand(prev => ({ ...prev, isOpen: false }));
      return;
    }

    if (command === 'type') {
      const { ast: withTrigger, cursorOffset } = insertText(
        cleaned, slashCommand.triggerPosition, '@',
      );
      commitAST(withTrigger, cursorOffset);
      setTimeout(() => checkTriggers(), 0);
      setSlashCommand(prev => ({ ...prev, isOpen: false }));
      return;
    }

    if (command === 'tag') {
      const { ast: withTrigger, cursorOffset } = insertText(
        cleaned, slashCommand.triggerPosition, '#',
      );
      commitAST(withTrigger, cursorOffset);
      setTimeout(() => checkTriggers(), 0);
      setSlashCommand(prev => ({ ...prev, isOpen: false }));
      return;
    }

    if (command === 'query' && onAddClass && queryClassId) {
      commitAST(cleaned, slashCommand.triggerPosition);
      onAddClass(queryClassId, false, 'query');
      setSlashCommand(prev => ({ ...prev, isOpen: false }));
      return;
    }

    if (command === 'table' && onAddClass && tableClassId) {
      commitAST(cleaned, slashCommand.triggerPosition);
      onAddClass(tableClassId, false, 'table');
      setSlashCommand(prev => ({ ...prev, isOpen: false }));
      return;
    }

    // Execute command
    commitAST(cleaned, slashCommand.triggerPosition);

    if (command === 'comment' && onOpenComments) onOpenComments();
    else if (command === 'property' && onAddProperty) onAddProperty();
    else if (command === 'image' && onAssetUpload) onAssetUpload(['image']);
    else if (command === 'audio' && onAssetUpload) onAssetUpload(['audio']);
    else if (command === 'file' && onAssetUpload) onAssetUpload();

    setSlashCommand(prev => ({ ...prev, isOpen: false }));
  }, [slashCommand.triggerPosition, commitAST, onAddClass, queryClassId, tableClassId, onOpenComments, onAddProperty, onAssetUpload, checkTriggers]);

  const handleSlashCommandClose = useCallback(() => {
    setSlashCommand(prev => ({ ...prev, isOpen: false }));
  }, []);

  // ─── Paste handler ─────────────────────────────────────────────
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!e.clipboardData) return;

    const analysis = analyzeClipboard(e.clipboardData);

    // Files
    if ((analysis.type === 'image' || analysis.type === 'audio' || analysis.type === 'file') && analysis.file) {
      onAssetUpload?.(analysis.file);
      return;
    }

    // HTML tables
    if (analysis.type === 'html-table' && onPasteTable && analysis.html) {
      const doc = new DOMParser().parseFromString(analysis.html, 'text/html');
      const table = doc.querySelector('table');
      if (table) {
        const caption = table.querySelector('caption')?.textContent?.trim();
        const headers: string[] = [];
        const rows: string[][] = [];

        const thead = table.querySelector('thead');
        if (thead) {
          thead.querySelectorAll('th').forEach(th => headers.push(th.textContent?.trim() || ''));
        }

        const tbody = table.querySelector('tbody') || table;
        let skipFirst = false;
        const trs = tbody.querySelectorAll('tr');

        if (headers.length === 0 && trs.length > 0) {
          const firstRow = trs[0];
          const ths = firstRow.querySelectorAll('th');
          if (ths.length > 0) {
            ths.forEach(th => headers.push(th.textContent?.trim() || ''));
            skipFirst = true;
          } else {
            const tds = firstRow.querySelectorAll('td');
            tds.forEach(td => headers.push(td.textContent?.trim() || ''));
            skipFirst = true;
          }
        }

        trs.forEach((tr, index) => {
          if (skipFirst && index === 0) return;
          const row: string[] = [];
          tr.querySelectorAll('td, th').forEach(td => row.push(td.textContent?.trim() || ''));
          if (row.length > 0) rows.push(row);
        });

        onPasteTable({ name: caption, headers, rows });
        return;
      }
    }

    // Multi-line content
    if (
      (analysis.type === 'html-list' || analysis.type === 'plain-multiline' ||
       (analysis.type === 'html-text' && analysis.blocks && analysis.blocks.length > 1)) &&
      analysis.blocks && analysis.blocks.length > 0 && onPasteBlocks
    ) {
      const cursorPos = editorRef.current ? getCursorPosition(editorRef.current) : 0;
      const [beforeAST, afterAST] = splitAtPosition(lastASTRef.current, cursorPos);

      const firstBlockContent = regenerateLinkUuids(analysis.blocks[0].content);

      // For the simple case, just merge the first block's text
      const mergedFirst = mergeDocuments(beforeAST, parseAST(firstBlockContent));

      const newBlocks: ParsedBlock[] = [];
      const flatBlks = flattenBlocks(analysis.blocks.slice(1));
      for (const block of flatBlks) {
        newBlocks.push({ content: regenerateLinkUuids(block.content), depth: block.depth });
      }

      const afterStr = JSON.stringify(afterAST);
      if (afterStr !== '[]') {
        newBlocks.push({ content: afterStr, depth: 0 });
      }

      onPasteBlocks(JSON.stringify(mergedFirst), newBlocks);
      return;
    }

    // Single line paste
    let text = analysis.text || '';
    text = regenerateLinkUuids(text);

    // Insert at cursor position via DOM
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      handleInput();
    }
  }, [onAssetUpload, onPasteBlocks, onPasteTable, handleInput, commitAST]);

  // ─── Popup position update ─────────────────────────────────────
  useEffect(() => {
    if ((!trigger.isOpen && !slashCommand.isOpen) || !editorRef.current) return;

    const updatePosition = () => {
      if (editorRef.current) {
        const coords = getCaretCoordinates(editorRef.current);
        if (trigger.isOpen) setTrigger(prev => ({ ...prev, position: coords }));
        if (slashCommand.isOpen) setSlashCommand(prev => ({ ...prev, position: coords }));
      }
    };

    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [trigger.isOpen, slashCommand.isOpen]);

  // ─── Link click handler (select the pill) ─────────────────────
  const handleEditorClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;

    const target = e.target as HTMLElement;
    const linkElement = target.closest('.inline-link, .tag-pill, .class-pill') as HTMLElement;
    if (!linkElement) return;

    // Select the pill element instead of opening a dialog
    e.preventDefault();
    e.stopPropagation();

    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNode(linkElement);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, [readOnly]);

  // ─── Context menu on right-click of link pills ─────────────────
  const handleEditorContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;

    const target = e.target as HTMLElement;
    const linkElement = target.closest('.inline-link') as HTMLElement;
    if (!linkElement) return;

    e.preventDefault();
    e.stopPropagation();

    const rawLinkId = linkElement.dataset.linkId;
    if (!rawLinkId) return;

    // Extract nodeId and UUID from "nodeId:uuid" format
    const colonIdx = rawLinkId.indexOf(':');
    const targetNodeIdStr = colonIdx > 0 ? rawLinkId.substring(0, colonIdx) : rawLinkId;
    const linkUuid = colonIdx > 0 ? rawLinkId.substring(colonIdx + 1) : rawLinkId;
    const targetNodeId = parseInt(targetNodeIdStr, 10);
    if (isNaN(targetNodeId)) return;

    // Look up whether the target is a page
    const targetIsPage = allNodesMap.get(targetNodeId)?.is_page ?? true;

    const rect = linkElement.getBoundingClientRect();
    setEditorContextMenu({
      position: { x: rect.left, y: rect.bottom + 4 },
      linkUuid,
      targetNodeId,
      isPage: targetIsPage,
    });
  }, [readOnly, allNodesMap]);

  const handleSaveLinkName = useCallback(async (linkUuid: string, newName: string | null) => {
    try {
      await updateLinkName(linkUuid, newName);
      queryClient.invalidateQueries({ queryKey: ['textLinks', nodeId] });
      setLinkNameDialog(null);
    } catch (error) {
      console.error('Failed to update link name:', error);
    }
  }, [nodeId, queryClient]);

  // Close linkNameDialog on click outside
  useEffect(() => {
    if (!linkNameDialog?.isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (linkNameDialogRef.current && !linkNameDialogRef.current.contains(e.target as globalThis.Node)) {
        setLinkNameDialog(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [linkNameDialog?.isOpen]);

  // ─── Editor context menu items ─────────────────────────────────
  const editorContextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!editorContextMenu) return [];
    const { linkUuid, targetNodeId, isPage: targetIsPage } = editorContextMenu;
    return [
      {
        id: 'open',
        label: targetIsPage ? 'Open page' : 'Open block',
        onClick: () => {
          openNode(targetNodeId, targetIsPage ? 'page' : 'block');
          setEditorContextMenu(null);
        },
      },
      {
        id: 'open-sidebar',
        label: 'Open in sidebar',
        shortcut: '⇧Click',
        onClick: () => {
          addSidebarCard(targetNodeId, targetIsPage ? 'page' : 'block');
          setEditorContextMenu(null);
        },
      },
      { id: 'sep1', label: '', separator: true },
      {
        id: 'custom-label',
        label: 'Edit link text',
        onClick: () => {
          const currentName = linkCustomNames.get(linkUuid) || null;
          setEditorContextMenu(null);
          setLinkNameDialog({
            isOpen: true,
            linkUuid,
            currentName,
            nodeId: nodeId ?? 0,
            position: { top: editorContextMenu.position.y, left: editorContextMenu.position.x },
          });
        },
      },
    ];
  }, [editorContextMenu, linkCustomNames, nodeId, openNode, addSidebarCard]);

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div className="block-editor">
      <div
        ref={editorRef}
        className="block-editor-input"
        contentEditable={!readOnly}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onPaste={handlePaste}
        onClick={handleEditorClick}
        onContextMenu={handleEditorContextMenu}
        onMouseUp={handleMouseUp}
        onCompositionStart={() => { setIsComposing(true); isComposingRef.current = true; }}
        onCompositionEnd={() => {
          setIsComposing(false);
          isComposingRef.current = false;
          handleInput();
        }}
        suppressContentEditableWarning
        data-placeholder=""
      />

      {!readOnly && (
        <>
          <SuggestionPopup
            isOpen={trigger.isOpen}
            query={trigger.query}
            type={trigger.type}
            position={trigger.position}
            onSelect={handleSelect}
            onClose={handleClose}
            onCreate={handleCreate}
            excludeNodeId={!isPage ? nodeId : undefined}
            showInlineOption={true}
            onSelectDatePage={handleDatePageSelect}
          />

          <SlashCommandPopup
            isOpen={slashCommand.isOpen}
            query={slashCommand.query}
            position={slashCommand.position}
            onSelect={handleSlashCommandSelect}
            onClose={handleSlashCommandClose}
          />

          <FloatingToolbar
            visible={selectionToolbar.visible}
            position={selectionToolbar.position}
            onBold={handleToolbarBold}
            onItalic={handleToolbarItalic}
            onUnderline={handleToolbarUnderline}
            onStrikethrough={handleToolbarStrikethrough}
            onLink={handleToolbarLink}
            boldActive={selectionToolbar.activeMarks.has('strong')}
            italicActive={selectionToolbar.activeMarks.has('em')}
            underlineActive={selectionToolbar.activeMarks.has('underline')}
            strikethroughActive={selectionToolbar.activeMarks.has('strikethrough')}
          />

          {linkNameDialog?.isOpen && (
            <div
              ref={linkNameDialogRef}
              className="link-name-dialog"
              style={{
                position: 'fixed',
                top: linkNameDialog.position.top,
                left: linkNameDialog.position.left,
                zIndex: 1000,
                background: 'var(--color-surface)',
                border: '1px solid var(--color-outline)',
                borderRadius: '8px',
                padding: '12px',
                boxShadow: 'var(--elevation-2)',
                minWidth: '250px',
              }}
              onClick={e => e.stopPropagation()}
              onMouseDown={e => e.stopPropagation()}
              onFocus={e => e.stopPropagation()}
            >
              <div style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 500 }}>
                Edit Link Text
              </div>
              <TextField
                value={linkNameDialog.currentName || ''}
                onChange={e => setLinkNameDialog({ ...linkNameDialog, currentName: e.target.value })}
                placeholder="Custom link text (leave empty for node name)"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSaveLinkName(linkNameDialog.linkUuid, linkNameDialog.currentName);
                  } else if (e.key === 'Escape') {
                    setLinkNameDialog(null);
                  }
                }}
              />
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px', justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={() => setLinkNameDialog(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => handleSaveLinkName(linkNameDialog.linkUuid, linkNameDialog.currentName)}
                >
                  Save
                </Button>
              </div>
            </div>
          )}

          {editorContextMenu && (
            <ContextMenu
              items={editorContextMenuItems}
              position={editorContextMenu.position}
              onClose={() => setEditorContextMenu(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function isPillEl(el: HTMLElement): boolean {
  return (
    el.classList?.contains('inline-link') ||
    el.classList?.contains('inline-node-link') ||
    el.classList?.contains('link-pill') ||
    el.classList?.contains('class-pill') ||
    el.classList?.contains('tag-pill')
  );
}
