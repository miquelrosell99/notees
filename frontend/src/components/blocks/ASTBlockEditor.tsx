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
import { createPortal, flushSync } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';

// CSS — reuse existing styles
import './BlockEditor.css';
import './InlineNodeLink.css';

// UI components
import { SuggestionPopup, type SuggestionType } from '../SuggestionPopup';
import { SlashCommandPopup } from '../SlashCommandPopup';
import { FloatingToolbar, type FloatingToolbarHandle } from '../core/FloatingToolbar';
import { NodePill } from '../NodePill';
import { LinkEditorCard } from '../LinkEditorCard';

// Hooks
import { useNodes, useTextLinks, useUpdateNode } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { usePendingSelectionForBlock, useEditorSelectionActions } from '@/stores/selectors';

// Utils
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
import { parseAST, buildLinkId, parseLinkId } from '@/lib/astBuilder';
import type { ASTDocument, ASTInlineNode } from '@/types/ast';
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
  getOffsetInElement,
  type ASTRenderContext,
  type ResolvedLink,
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
  deleteRange,
  insertNodeLink,
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
  const floatingToolbarRef = useRef<FloatingToolbarHandle>(null);

  // ─── Portal mount points for NodePill rendering ───────────────
  interface MountPoint {
    element: HTMLElement;
    linkId: string;
    refType: 'node' | 'class';
  }
  const mountPointsRef = useRef<MountPoint[]>([]);
  const [mountVersion, setMountVersion] = useState(0);

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
  const [linkEditorCard, setLinkEditorCard] = useState<{
    isOpen: boolean;
    linkId: string;
    linkUuid: string;
    currentNodeId: number | null;
    currentName: string | null;
    position: { top: number; left: number };
    mode: 'edit' | 'create' | 'create-url';
    initialUrl?: string;
    initialText?: string;
    selectionStart?: number;
    selectionEnd?: number;
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
  const { data: textLinks } = useTextLinks(nodeId ?? null);
  const updateNode = useUpdateNode();

  // Map of link UUID → custom display name (from node_link.name)
  const linkCustomNames = useMemo(() => {
    const map = new Map<string, string>();
    if (textLinks) {
      for (const link of textLinks) {
        if (link.uuid && link.name) {
          map.set(link.uuid, link.name);
        }
      }
    }
    return map;
  }, [textLinks]);

  // Map of link UUID → target node ID (from node_link.target_node_id)
  // This is the canonical way to resolve link targets — NOT from the AST nodeUuid
  const linkTargets = useMemo(() => {
    const map = new Map<string, number>();
    if (textLinks) {
      for (const link of textLinks) {
        if (link.uuid) {
          map.set(link.uuid, link.target_node_id);
        }
      }
    }
    return map;
  }, [textLinks]);

  // Map of all nodes by ID — used only for class pill resolution in renderCtx
  const allNodesMap = useMemo(() => {
    if (!allNodes || !allNodesFetched) return new Map<number, Node>();
    return new Map(allNodes.map(n => [n.id, n]));
  }, [allNodes, allNodesFetched]);

  // ─── Render context (only resolves class pills — node links use portals) ──
  const renderCtx = useMemo<ASTRenderContext>(() => ({
    resolveLink: (linkId: string, refType: 'node' | 'class'): ResolvedLink | null => {
      // Node links are rendered as placeholder spans → no resolution needed
      if (refType !== 'class') return null;

      // Class refs: link_id is "nodeUuid:linkUuid" — resolve via linkTargets map
      const parsed = parseLinkId(linkId);
      const targetNodeId = parsed.linkUuid ? linkTargets.get(parsed.linkUuid) : undefined;

      // Fallback: try parsing as legacy numeric ID
      const numericId = targetNodeId ?? parseInt(linkId, 10);
      if (!isNaN(numericId) && allNodesFetched) {
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

      // Data still loading — show placeholder
      if (!allNodesFetched) {
        return { displayText: '…', targetName: '…', isTag: false, effectiveIcon: null, customLabel: null, linkStatus: 'valid' };
      }
      return null;
    },
  }), [allNodesMap, allNodesFetched, linkTargets]);

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

    // Collect placeholder mount points for NodePill portals
    const points: MountPoint[] = [];
    editorRef.current.querySelectorAll('.node-link-mount').forEach((el) => {
      const linkId = el.getAttribute('data-link-id') || '';
      const refType = (el.getAttribute('data-ref-type') as 'node' | 'class') || 'node';
      points.push({ element: el as HTMLElement, linkId, refType });
    });
    mountPointsRef.current = points;
    // Force synchronous re-render with portals to prevent flash
    flushSync(() => {
      setMountVersion(v => v + 1);
    });
  }, [renderCtx]);

  // ─── Content sync effect ───────────────────────────────────────
  useLayoutEffect(() => {
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

  // ─── Pending selection restoration ─────────────────────────────
  useLayoutEffect(() => {
    if (!pendingSelection || !editorRef.current) return;
    if (pendingSelection.anchorBlockId !== nodeId) return;

    if (document.activeElement !== editorRef.current) {
      editorRef.current.focus();
    }

    // Projection mode: use original click coordinates to find cursor position
    // in the editor's own DOM (which has the correct pill placeholders)
    if (pendingSelection.clickX !== undefined && pendingSelection.clickY !== undefined) {
      const x = pendingSelection.clickX;
      const y = pendingSelection.clickY;
      let placed = false;

      // Try standard API first (Firefox, newer browsers)
      if ('caretPositionFromPoint' in document) {
        const pos = (document as any).caretPositionFromPoint(x, y);
        if (pos) {
          const range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
          range.collapse(true);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
          placed = true;
        }
      }
      // Fallback to WebKit API (Chrome, Safari)
      if (!placed && 'caretRangeFromPoint' in document) {
        const range = (document as Document).caretRangeFromPoint(x, y);
        if (range) {
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
          placed = true;
        }
      }
      // If projection failed, fall back to end of content
      if (!placed) {
        const contentLen = getContentLength(editorRef.current);
        setCursorPosition(editorRef.current, contentLen);
      }
    } else if (pendingSelection.caretX !== undefined) {
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
    // Calculate offsets directly from range endpoints without touching window.getSelection()
    const start = getOffsetInElement(editorRef.current, range.startContainer, range.startOffset);
    const end = getOffsetInElement(editorRef.current, range.endContainer, range.endOffset);

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

  const handleToolbarLink = useCallback(() => {
    if (!selectionToolbar.visible || !editorRef.current) return;
    
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const editorRect = editorRef.current.getBoundingClientRect();

    // Get selected text
    const selectedText = sel.toString().trim();

    // Check if selected text is a URL
    const urlRegex = /^https?:\/\/.+/i;
    const isUrl = urlRegex.test(selectedText);

    // Capture selection range BEFORE opening popup
    const actualStart = Math.min(selectionToolbar.start, selectionToolbar.end);
    const actualEnd = Math.max(selectionToolbar.start, selectionToolbar.end);

    // Position below selection
    const position = {
      top: rect.bottom - editorRect.top + 4,
      left: rect.left - editorRect.left,
    };

    // Open LinkEditorCard in URL mode
    setLinkEditorCard({
      isOpen: true,
      linkId: '',
      linkUuid: generateLinkUuid(),
      currentNodeId: null,
      currentName: null,
      position,
      mode: 'create-url',
      initialUrl: isUrl ? selectedText : '',
      initialText: isUrl ? '' : selectedText,
      selectionStart: actualStart,
      selectionEnd: actualEnd,
    });
    
    // Hide the floating toolbar
    setSelectionToolbar(prev => ({ ...prev, visible: false }));
  }, [selectionToolbar, commitAST]);

  // ─── Handle toolbar close (ArrowUp pressed in toolbar) ─────────
  const handleToolbarClose = useCallback(() => {
    setSelectionToolbar(prev => ({ ...prev, visible: false }));
    // Restore focus to the editor
    editorRef.current?.focus();
  }, []);

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
        // Convert empty AST arrays to empty string, not "[]"
        const beforeStr = before.length === 0 ? '' : JSON.stringify(before);
        const afterStr = after.length === 0 ? '' : JSON.stringify(after);
        onEnterCreateBlock(beforeStr, afterStr);
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

    // ── Ctrl+L: insert/edit link ──
    if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
      e.preventDefault();
      handleInsertLink();
      return;
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
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey) {
      handleArrowNavigation(e);
    }

    // ── ArrowDown: focus floating toolbar when visible and text is selected ──
    if (e.key === 'ArrowDown' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && selectionToolbar.visible) {
        e.preventDefault();
        floatingToolbarRef.current?.focusFirstButton();
        return;
      }
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
    nodeUuid, commitAST, selectionToolbar.visible,
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
      // Use "nodeUuid:linkUuid" format for human-readable AST and damage control
      const compoundLinkId = buildLinkId(node.uuid, linkUuid);
      const result = replaceTriggerWithLink(
        lastASTRef.current,
        trigger.triggerPosition,
        cursorPos,
        compoundLinkId,
        'node',
      );
      // Also notify parent about the link
      onLinkPage?.(node);

      commitAST(result.ast, result.cursorOffset);
    } else if (trigger.type === 'tag' && keepInline) {
      const linkUuid = generateLinkUuid();
      const compoundLinkId = buildLinkId(node.uuid, linkUuid);
      const result = replaceTriggerWithLink(
        lastASTRef.current,
        trigger.triggerPosition,
        cursorPos,
        compoundLinkId,
        'node',
      );
      onAddTag?.(node.id, keepInline, node.name || '');
      commitAST(result.ast, result.cursorOffset);
    } else if (trigger.type === 'type' && keepInline) {
      const linkUuid = generateLinkUuid();
      const compoundLinkId = buildLinkId(node.uuid, linkUuid);
      const result = replaceTriggerWithLink(
        lastASTRef.current,
        trigger.triggerPosition,
        cursorPos,
        compoundLinkId,
        'class',
      );
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
  }, [trigger, commitAST, onAddClass, onAddTag, onLinkPage]);

  const handleCreate = useCallback(async (name: string, keepInline: boolean) => {
    if (!editorRef.current) return;

    const cursorPos = getCursorPosition(editorRef.current);

    if (trigger.type === 'link') {
      const newPageId = await onCreatePageLink?.(name);
      if (newPageId) {
        const linkUuid = generateLinkUuid();
        const compoundLinkId = buildLinkId(newPageId, linkUuid);
        const result = replaceTriggerWithLink(
          lastASTRef.current,
          trigger.triggerPosition,
          cursorPos,
          compoundLinkId,
          'node',
        );
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
    const compoundLinkId = buildLinkId(_pageId, linkUuid);
    const result = replaceTriggerWithLink(
      lastASTRef.current,
      trigger.triggerPosition,
      cursorPos,
      compoundLinkId,
      'node',
    );
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

    if (command === 'url') {
      // Open LinkEditorCard in URL mode
      commitAST(cleaned, slashCommand.triggerPosition);
      const editorRect = editorRef.current.getBoundingClientRect();
      const position = {
        top: slashCommand.position.top - editorRect.top,
        left: slashCommand.position.left - editorRect.left,
      };
      setLinkEditorCard({
        isOpen: true,
        linkId: '',
        linkUuid: generateLinkUuid(),
        currentNodeId: null,
        currentName: null,
        position,
        mode: 'create-url',
        initialUrl: '',
        initialText: '',
      });
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

  // ─── Link click handler (node pills handled via portal callbacks) ─
  const handleEditorClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;

    const target = e.target as HTMLElement;
    // Node link pills (including class refs) are handled by NodePill via portal callbacks
    // No special link handling needed in the editor click handler
  }, [readOnly]);

  // ─── External link context menu (right-click to edit URL) ─
  const handleEditorContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;

    // Walk up from target to find an <a class="external-link"> element
    let target = e.target as HTMLElement | null;
    let linkEl: HTMLAnchorElement | null = null;
    while (target && target !== editorRef.current) {
      if (target.tagName === 'A' && target.classList.contains('external-link')) {
        linkEl = target as HTMLAnchorElement;
        break;
      }
      target = target.parentElement;
    }
    if (!linkEl || !editorRef.current) return;

    e.preventDefault();
    e.stopPropagation();

    // Compute AST offset range of this <a> element
    const startOffset = getOffsetInElement(editorRef.current, linkEl, 0);
    const endOffset = startOffset + (linkEl.textContent?.replace(/\u200B/g, '').length ?? 0);

    const currentUrl = linkEl.dataset.url || linkEl.getAttribute('href') || '';
    const currentText = linkEl.textContent?.replace(/\u200B/g, '') || '';

    const linkRect = linkEl.getBoundingClientRect();
    const editorRect = editorRef.current.getBoundingClientRect();

    setLinkEditorCard({
      isOpen: true,
      linkId: '',
      linkUuid: '',
      currentNodeId: null,
      currentName: null,
      position: {
        top: linkRect.bottom - editorRect.top + 4,
        left: linkRect.left - editorRect.left,
      },
      mode: 'create-url',
      initialUrl: currentUrl,
      initialText: currentText,
      selectionStart: startOffset,
      selectionEnd: endOffset,
    });
  }, [readOnly]);

  // ─── Portal pill callbacks (remove, color, edit link) ──

  const handlePillRemove = useCallback((linkId: string) => {
    const removeLink = (nodes: ASTInlineNode[]): ASTInlineNode[] =>
      nodes.flatMap(n => {
        if (n.type === 'node_link' && n.link_id === linkId) {
          return []; // Remove
        }
        if ('children' in n && n.type !== 'node_link') {
          return [{ ...n, children: removeLink((n as { children: ASTInlineNode[] }).children) } as ASTInlineNode];
        }
        return [n];
      });

    const newAST = lastASTRef.current.map(para => ({
      ...para,
      children: removeLink(para.children),
    }));
    commitAST(normalizeAST(newAST));
  }, [commitAST]);

  const handlePillColorChange = useCallback((linkId: string, color: string | null) => {
    const parsed = parseLinkId(linkId);
    // Resolve target via node_link table (linkTargets map), NOT from AST nodeUuid
    const targetNodeId = parsed.linkUuid ? linkTargets.get(parsed.linkUuid) : undefined;
    if (targetNodeId) {
      updateNode.mutate({ id: targetNodeId, data: { color } });
    }
  }, [updateNode, linkTargets]);

  const handlePillEditLink = useCallback((linkId: string, pillRect: DOMRect) => {
    const parsed = parseLinkId(linkId);
    const linkUuid = parsed.linkUuid || linkId;
    const currentName = linkCustomNames.get(linkUuid) || null;
    // Resolve target via node_link table, NOT from AST nodeUuid
    const targetNodeId = linkTargets.get(linkUuid) ?? null;
    // Compute position relative to editor (absolute positioning, like FloatingToolbar)
    const editorRect = editorRef.current?.getBoundingClientRect();
    const top = editorRect
      ? pillRect.bottom - editorRect.top + 4
      : pillRect.bottom + 4;
    const left = editorRect
      ? pillRect.left - editorRect.left
      : pillRect.left;
    setLinkEditorCard({
      isOpen: true,
      linkId,
      linkUuid,
      currentNodeId: targetNodeId,
      currentName,
      position: { top, left },
      mode: 'edit',
    });
  }, [linkCustomNames, linkTargets]);

  // ── Insert new link (Ctrl+L) ──
  const handleInsertLink = useCallback(() => {
    if (!editorRef.current) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const editorRect = editorRef.current.getBoundingClientRect();

    // Get selected text if any
    const selectedText = sel.toString().trim();

    // Check if selected text is a URL
    const urlRegex = /^https?:\/\/.+/i;
    const isUrl = urlRegex.test(selectedText);

    // Capture selection range if there is a selection
    let selectionStart: number | undefined;
    let selectionEnd: number | undefined;
    if (!sel.isCollapsed) {
      const clonedRange = range.cloneRange();
      clonedRange.collapse(true);
      const tempSel = window.getSelection();
      tempSel?.removeAllRanges();
      tempSel?.addRange(clonedRange);
      const start = getCursorPosition(editorRef.current);
      
      const endRange = range.cloneRange();
      endRange.collapse(false);
      tempSel?.removeAllRanges();
      tempSel?.addRange(endRange);
      const end = getCursorPosition(editorRef.current);
      
      tempSel?.removeAllRanges();
      tempSel?.addRange(range);

      selectionStart = Math.min(start, end);
      selectionEnd = Math.max(start, end);
    }

    // Position below cursor/selection (relative to editor, like FloatingToolbar)
    const position = {
      top: rect.bottom - editorRect.top + 4,
      left: rect.left - editorRect.left,
    };

    // Always open in URL mode for Ctrl+L
    setLinkEditorCard({
      isOpen: true,
      linkId: '',
      linkUuid: generateLinkUuid(),
      currentNodeId: null,
      currentName: null,
      position,
      mode: 'create-url',
      initialUrl: isUrl ? selectedText : '',
      initialText: isUrl ? '' : selectedText,
      selectionStart,
      selectionEnd,
    });
  }, [linkCustomNames, linkTargets]);

  const handleSaveLinkEditor = useCallback(async (linkUuid: string, _newNodeId: number, newNodeUuid: string, newCustomName: string | null) => {
    try {
      if (!linkEditorCard) return;
      const oldLinkId = linkEditorCard.linkId;
      const oldTargetId = linkEditorCard.currentNodeId;

      // Creating new link
      if (linkEditorCard.mode === 'create' && editorRef.current) {
        const newLinkUuid = generateLinkUuid();
        const newLinkId = buildLinkId(newNodeUuid, newLinkUuid);
        const sel = window.getSelection();
        
        if (sel && !sel.isCollapsed) {
          // Replace selected text with link
          const range = sel.getRangeAt(0);
          const clonedRange = range.cloneRange();
          clonedRange.collapse(true);
          const tempSel = window.getSelection();
          tempSel?.removeAllRanges();
          tempSel?.addRange(clonedRange);
          const start = getCursorPosition(editorRef.current);
          
          const endRange = range.cloneRange();
          endRange.collapse(false);
          tempSel?.removeAllRanges();
          tempSel?.addRange(endRange);
          const end = getCursorPosition(editorRef.current);
          
          tempSel?.removeAllRanges();
          tempSel?.addRange(range);

          const actualStart = Math.min(start, end);
          const actualEnd = Math.max(start, end);

          // Delete selected text and insert link
          const cleaned = deleteRange(lastASTRef.current, actualStart, actualEnd);
          const result = insertNodeLink(cleaned, actualStart, newLinkId, 'node');
          
          onLinkPage?.({ id: _newNodeId, uuid: newNodeUuid } as Node);
          commitAST(result.ast, result.cursorOffset);
        } else {
          // Insert link at cursor
          const cursorPos = getCursorPosition(editorRef.current);
          const result = insertNodeLink(lastASTRef.current, cursorPos, newLinkId, 'node');
          onLinkPage?.({ id: _newNodeId, uuid: newNodeUuid } as Node);
          commitAST(result.ast, result.cursorOffset);
        }
        
        // Save custom name if provided
        if (newCustomName) {
          await updateLinkName(newLinkUuid, newCustomName);
        }
        
        setLinkEditorCard(null);
        return;
      }

      // Editing existing link - node target changed
      if (_newNodeId !== oldTargetId) {
        const newLinkUuid = generateLinkUuid();
        const newLinkId = buildLinkId(newNodeUuid, newLinkUuid);

        const replaceLink = (nodes: ASTInlineNode[]): ASTInlineNode[] =>
          nodes.map(n => {
            if (n.type === 'node_link' && n.link_id === oldLinkId) {
              return { ...n, link_id: newLinkId };
            }
            if ('children' in n && n.type !== 'node_link') {
              return { ...n, children: replaceLink((n as { children: ASTInlineNode[] }).children) } as ASTInlineNode;
            }
            return n;
          });

        const newAST = lastASTRef.current.map(para => ({
          ...para,
          children: replaceLink(para.children),
        }));
        // onLinkPage notification (dead code — never provided by callers)
        onLinkPage?.({ id: _newNodeId, uuid: newNodeUuid } as Node);
        commitAST(newAST);

        // Save custom name on the new link UUID
        if (newCustomName) {
          await updateLinkName(newLinkUuid, newCustomName);
        }
      } else {
        // Same target — just update custom name
        await updateLinkName(linkUuid, newCustomName);
      }

      queryClient.invalidateQueries({ queryKey: ['textLinks', nodeId] });
      setLinkEditorCard(null);
    } catch (error) {
      console.error('Failed to save link editor:', error);
    }
  }, [linkEditorCard, nodeId, queryClient, commitAST, onLinkPage]);

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

      {/* Node link pill portals — mount React NodePill into each placeholder */}
      {mountPointsRef.current.map((mp, i) => {
        const parsed = parseLinkId(mp.linkId);
        const customName = parsed.linkUuid ? linkCustomNames.get(parsed.linkUuid) : undefined;
        // Resolve target via node_link table, NOT from AST nodeUuid
        const targetNodeId = parsed.linkUuid ? linkTargets.get(parsed.linkUuid) : undefined;

        return createPortal(
          <NodePill
            key={`${mountVersion}-${i}`}
            nodeId={targetNodeId}
            variant="link"
            refType={mp.refType}
            editMode={true}
            customName={customName ?? null}
            onEditLink={parsed.linkUuid ? (pillRect: DOMRect) => handlePillEditLink(mp.linkId, pillRect) : undefined}
            onRemove={() => handlePillRemove(mp.linkId)}
            onColorChange={(color: string | null) => handlePillColorChange(mp.linkId, color)}
          />,
          mp.element,
        );
      })}

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
            ref={floatingToolbarRef}
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
            onClose={handleToolbarClose}
          />

          {linkEditorCard?.isOpen && linkEditorCard.mode !== 'create-url' && (
            <LinkEditorCard
              mode="node"
              linkUuid={linkEditorCard.linkUuid}
              currentNodeId={linkEditorCard.currentNodeId}
              currentCustomName={linkEditorCard.currentName}
              position={linkEditorCard.position}
              onSave={handleSaveLinkEditor}
              onDelete={() => {
                if (linkEditorCard.linkId) {
                  handlePillRemove(linkEditorCard.linkId);
                }
                setLinkEditorCard(null);
              }}
              onClose={() => setLinkEditorCard(null)}
              onModeToggle={(mode) => {
                // Switch to URL mode, preserve position and state
                setLinkEditorCard({
                  ...linkEditorCard,
                  mode: 'create-url',
                  initialUrl: '',
                  initialText: linkEditorCard.currentName || '',
                });
              }}
            />
          )}

          {linkEditorCard?.isOpen && linkEditorCard.mode === 'create-url' && (
            <LinkEditorCard
              mode="url"
              currentUrl={linkEditorCard.initialUrl || ''}
              currentText={linkEditorCard.initialText || ''}
              position={linkEditorCard.position}
              onSave={(url, displayText) => {
                // Insert/wrap external link using stored selection range
                if (editorRef.current && linkEditorCard) {
                  if (linkEditorCard.selectionStart !== undefined && linkEditorCard.selectionEnd !== undefined) {
                    // Wrap the stored selection in external link
                    const result = wrapInExternalLink(
                      lastASTRef.current, 
                      linkEditorCard.selectionStart, 
                      linkEditorCard.selectionEnd, 
                      url
                    );
                    commitAST(result.ast, result.end);
                  } else {
                    // Insert link text at cursor
                    const cursorPos = getCursorPosition(editorRef.current);
                    const textToInsert = displayText || url;
                    const withText = insertText(lastASTRef.current, cursorPos, textToInsert);
                    const result = wrapInExternalLink(withText.ast, cursorPos, cursorPos + textToInsert.length, url);
                    commitAST(result.ast, result.end);
                  }
                }
                setLinkEditorCard(null);
              }}
              onDelete={() => {
                // If editing an existing external link, unwrap it (remove link, keep text)
                if (editorRef.current && linkEditorCard?.selectionStart !== undefined && linkEditorCard?.selectionEnd !== undefined) {
                  const result = wrapInExternalLink(
                    lastASTRef.current,
                    linkEditorCard.selectionStart,
                    linkEditorCard.selectionEnd,
                    '' // empty URL = unwrap
                  );
                  commitAST(result.ast, result.end);
                }
                setLinkEditorCard(null);
              }}
              onClose={() => setLinkEditorCard(null)}
              onModeToggle={(mode) => {
                // Switch to node mode, preserve position and state  
                setLinkEditorCard({
                  ...linkEditorCard,
                  mode: 'create',
                  currentNodeId: null,
                  currentName: linkEditorCard.initialText || '',
                });
              }}
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
    el.classList?.contains('node-link-mount') ||
    el.classList?.contains('link-pill') ||
    el.classList?.contains('tag-pill')
  );
}
