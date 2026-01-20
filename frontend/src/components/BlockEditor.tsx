/**
 * Block editor component for editing content
 * 
 * Uses contenteditable with pill elements for links:
 * - [[page links]] and ((block links)) rendered as non-editable pills
 * - Cursor navigation selects pills when reached
 * - Backspace/Delete removes selected pills
 * 
 * Supports:
 * - @ trigger for types (sets the node's "types" property)
 * - # trigger for tags (sets the node's "tags" property)
 * - [[ trigger for page links (inserts [[Page Name]] format)
 * - / trigger for slash commands (including add comment)
 * - Enter: add to property only (for @ and #) or insert link (for [[)
 * - Ctrl+Enter: add to property AND keep inline
 * 
 * Note: This component is the pure editor. The bullet point and comment 
 * indicator are rendered by the parent Block component.
 */
import { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import './BlockEditor.css';
import { SuggestionPopup, type SuggestionType } from './core/SuggestionPopup';
import { SlashCommandPopup } from './core/SlashCommandPopup';
import { useNodes } from '@/hooks';
import { mdiFileDocumentOutline, mdiCircleSmall } from '@mdi/js';
import type { Node } from '@/types';

// Task states for cycling with Shift+Enter
export const TASK_STATES = ['todo', 'doing', 'done', 'cancelled'] as const;
export type TaskState = typeof TASK_STATES[number];

interface BlockEditorProps {
  /** Node ID for filtering self from link suggestions */
  nodeId?: number;
  /** Whether this node is a page (pages can link to themselves) */
  isPage?: boolean;
  /** Node UUID for block link format when copying */
  nodeUuid?: string;
  content: string;
  onChange: (content: string) => void;
  /** Initial cursor position when entering edit mode. If provided, cursor will be set here instead of end */
  initialCursorPosition?: number;
  onAddType?: (typeNodeId: number, keepInline: boolean, typeName: string) => void;
  onAddTag?: (tagNodeId: number, keepInline: boolean, tagName: string) => void;
  onCreateType?: (name: string, keepInline: boolean) => void;
  onCreateTag?: (name: string, keepInline: boolean) => void;
  onLinkPage?: (pageNode: Node) => void;
  onCreatePageLink?: (name: string) => Promise<string | undefined>;  // Returns the new page ID
  onOpenComments?: () => void;
  /** Callback for asset upload. Can pass types filter or a file to upload directly */
  onAssetUpload?: (assetTypesOrFile?: ('image' | 'audio' | 'file')[] | File) => void;
  readOnly?: boolean;
  /** Called when user presses Escape to exit edit mode */
  onEscape?: () => void;
  /** Called when user presses arrow up at beginning of text */
  onNavigateUp?: () => void;
  /** Called when user presses arrow down at end of text */
  onNavigateDown?: () => void;
  /** Called with shift+arrow for extending selection */
  onExtendSelection?: (direction: 'up' | 'down') => void;
  /** Whether this block is a task (enables Shift+Enter state cycling) */
  isTask?: boolean;
  /** Current task state */
  taskState?: TaskState;
  /** Called when Shift+Enter is pressed to cycle task state */
  onTaskStateChange?: (newState: TaskState) => void;
  /** Called when Enter is pressed to create a new block. Receives text before and after cursor */
  onEnterCreateBlock?: (textBeforeCursor: string, textAfterCursor: string) => void;
  /** Called when Backspace is pressed at start of block with text remaining */
  onBackspaceAtStart?: (remainingText: string) => void;
  /** Called when Delete is pressed at end of block */
  onDeleteAtEnd?: () => void;
  /** Called when Tab is pressed - indent block (move as child of previous sibling) */
  onIndent?: () => void;
  /** Called when Shift+Tab is pressed - outdent block (move to parent's level) */
  onOutdent?: () => void;
  /** Ref to expose the editor element for external focus management */
  editorRef?: React.RefObject<HTMLDivElement | null>;
}

interface TriggerState {
  isOpen: boolean;
  type: SuggestionType;
  query: string;
  triggerPosition: number; // cursor position where trigger started
  position: { top: number; left: number };
}

interface LinkInfo {
  linkId: string;  // The link record ID
  start: number;
  end: number;
  raw: string;
}

/**
 * Parse content to find all links - unified [[linkId]] format
 */
function parseLinks(content: string): LinkInfo[] {
  const links: LinkInfo[] = [];
  
  // Find all links [[id]]
  let match;
  const linkRegex = /\[\[([^\]]+)\]\]/g;
  while ((match = linkRegex.exec(content)) !== null) {
    links.push({
      linkId: match[1],
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
    });
  }
  
  // Sort by position
  links.sort((a, b) => a.start - b.start);
  
  return links;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert plain text content with link markers to HTML with pill elements
 * @param content - The raw content with [[linkId]] markers
 * @param linkNames - Map of linkId -> {name, isPage, clickCount} for display
 */
function contentToHtml(content: string, linkNames: Map<string, { name: string; isPage: boolean; clickCount?: number }>): string {
  const links = parseLinks(content);
  
  if (links.length === 0) {
    return escapeHtml(content);
  }
  
  let html = '';
  let lastEnd = 0;
  
  for (const link of links) {
    // Add text before this link
    if (link.start > lastEnd) {
      html += escapeHtml(content.substring(lastEnd, link.start));
    }
    
    // Look up the link info
    const linkInfo = linkNames.get(link.linkId);
    const displayText = linkInfo?.name || link.linkId;
    const isPage = linkInfo?.isPage ?? true;
    const clickCount = linkInfo?.clickCount ?? 0;
    const pillClass = isPage ? 'link-pill--page' : 'link-pill--block';
    // Use SVG icons matching ContentWithPills (NodeIcon renders these)
    const iconPath = isPage ? mdiFileDocumentOutline : mdiCircleSmall;
    const iconSvg = `<svg viewBox="0 0 24 24" style="width: 14.4px; height: 14.4px;"><path fill="currentColor" d="${iconPath}"></path></svg>`;
    const icon = `<span class="link-pill__icon">${iconSvg}</span>`;
    const badge = clickCount > 0 
      ? `<span class="link-pill__badge">${clickCount}</span>` 
      : '';
    
    html += `<span class="link-pill ${pillClass}" contenteditable="false" data-link-id="${escapeAttr(link.linkId)}" data-link-raw="${escapeAttr(link.raw)}">${icon}<span class="link-pill__text">${escapeHtml(displayText)}</span>${badge}</span>`;
    
    // Add zero-width space after pill if no text follows immediately
    // This ensures the cursor has a text node to anchor to when navigating
    const nextChar = content[link.end];
    if (!nextChar || nextChar === '[') {
      html += '\u200B';
    }
    
    lastEnd = link.end;
  }
  
  // Add remaining text
  if (lastEnd < content.length) {
    html += escapeHtml(content.substring(lastEnd));
  } else if (links.length > 0) {
    // Ensure there's a ZWS at the end if content ends with a pill
    html += '\u200B';
  }
  
  return html;
}

/**
 * Convert HTML back to plain text content with link markers
 * Strips zero-width spaces that were added for cursor positioning
 */
function htmlToContent(element: HTMLElement): string {
  let content = '';
  
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      // Strip zero-width spaces (\u200B) that we added for cursor positioning
      content += (node.textContent || '').replace(/\u200B/g, '');
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.classList.contains('link-pill')) {
        // Get the raw link text from data attribute
        content += el.dataset.linkRaw || '';
      } else if (el.tagName === 'BR') {
        // Ignore BR tags - we don't allow newlines
      } else {
        // Recurse into other elements
        content += htmlToContent(el);
      }
    }
  }
  
  return content;
}

/**
 * Get caret position for popup placement
 */
function getCaretCoordinates(element: HTMLDivElement): { top: number; left: number } {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const rect = element.getBoundingClientRect();
    return { top: rect.top + 24, left: rect.left };
  }
  
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  
  // If rect is empty (cursor at start/end), use element position
  if (rect.width === 0 && rect.height === 0) {
    const elementRect = element.getBoundingClientRect();
    return { top: elementRect.top + 24, left: elementRect.left };
  }
  
  return {
    top: rect.bottom + 4,
    left: rect.left,
  };
}

/**
 * Get cursor position in plain text content
 */
function getCursorPosition(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;
  
  const range = selection.getRangeAt(0);
  let position = 0;
  
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    null
  );
  
  let node;
  while ((node = walker.nextNode())) {
    if (node === range.startContainer) {
      position += range.startOffset;
      break;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      position += node.textContent?.length || 0;
    } else if ((node as HTMLElement).classList?.contains('link-pill')) {
      const raw = (node as HTMLElement).dataset.linkRaw || '';
      position += raw.length;
      // Skip past this node's children
      walker.nextSibling();
    }
  }
  
  return position;
}

/**
 * Set cursor position in the contenteditable
 */
function setCursorPosition(element: HTMLElement, targetPosition: number): void {
  let currentPosition = 0;
  
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    null
  );
  
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length || 0;
      if (currentPosition + length >= targetPosition) {
        const range = document.createRange();
        range.setStart(node, targetPosition - currentPosition);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      currentPosition += length;
    } else if ((node as HTMLElement).classList?.contains('link-pill')) {
      const raw = (node as HTMLElement).dataset.linkRaw || '';
      const length = raw.length;
      if (currentPosition + length >= targetPosition) {
        // Position cursor after this pill
        const range = document.createRange();
        const parent = node.parentNode;
        if (parent) {
          const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
          range.setStart(parent, index + 1);
          range.collapse(true);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        return;
      }
      currentPosition += length;
    }
  }
  
  // Position at end if target is past content
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function BlockEditor({ 
  nodeId,
  isPage,
  nodeUuid,
  content, 
  onChange, 
  initialCursorPosition,
  onAddType,
  onAddTag,
  onCreateType,
  onCreateTag,
  onLinkPage,
  onCreatePageLink,
  onOpenComments,
  onAssetUpload,
  readOnly = false,
  onEscape,
  onNavigateUp,
  onNavigateDown,
  onExtendSelection,
  isTask = false,
  taskState,
  onTaskStateChange,
  onEnterCreateBlock,
  onBackspaceAtStart,
  onDeleteAtEnd,
  onIndent,
  onOutdent,
  editorRef: externalEditorRef,
}: BlockEditorProps) {
  const internalEditorRef = useRef<HTMLDivElement>(null);
  const editorRef = internalEditorRef;
  
  // Track if initial cursor position has been applied
  const initialCursorApplied = useRef(false);
  
  // Track internal changes
  const lastContentRef = useRef(content);
  const isInternalChange = useRef(false);
  
  // Selected pill state
  const [selectedPill, setSelectedPill] = useState<HTMLElement | null>(null);
  
  // Composing state (for IME)
  const [isComposing, setIsComposing] = useState(false);
  
  // Extract link IDs from content
  const linkIds = useMemo(() => {
    const ids: string[] = [];
    const linkRegex = /\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      ids.push(match[1]);
    }
    return ids;
  }, [content]);
  
  // Fetch all nodes to get names for links
  const { data: allNodes } = useNodes(linkIds.length > 0 ? {} : null);
  
  // Build link names map from fetched nodes
  const linkNames = useMemo(() => {
    const map = new Map<string, { name: string; isPage: boolean; clickCount?: number }>();
    if (allNodes && linkIds.length > 0) {
      for (const linkId of linkIds) {
        // linkId could be a node ID (number as string) - find the node
        const nodeId = parseInt(linkId, 10);
        const node = !isNaN(nodeId) 
          ? allNodes.find(n => n.id === nodeId)
          : allNodes.find(n => n.uuid === linkId || n.name === linkId);
        if (node) {
          map.set(linkId, {
            name: node.name || node.display_name || 'Untitled',
            isPage: node.is_page || node.parent_id === null,
            // TODO: could add click count from link data if available
          });
        }
      }
    }
    return map;
  }, [allNodes, linkIds]);
  
  // Sync external ref
  useEffect(() => {
    if (externalEditorRef && internalEditorRef.current) {
      (externalEditorRef as React.MutableRefObject<HTMLDivElement | null>).current = internalEditorRef.current;
    }
  }, [externalEditorRef]);
  
  // Track linkNames size to detect when node data loads
  const linkNamesSize = linkNames.size;
  
  // Update HTML when content changes externally or when linkNames loads
  useEffect(() => {
    if (editorRef.current && !isInternalChange.current) {
      // Re-render if content changed OR if linkNames just loaded (for link display names)
      const html = contentToHtml(content, linkNames);
      const currentHtml = editorRef.current.innerHTML;
      
      // Only update if the HTML would actually change (preserves cursor position when possible)
      if (html !== currentHtml && (html || '<br>') !== currentHtml) {
        // Save cursor position before update
        const savedCursorPos = getCursorPosition(editorRef.current);
        
        editorRef.current.innerHTML = html || '<br>';
        lastContentRef.current = content;
        
        // Restore cursor position after update (if we had focus)
        if (document.activeElement === editorRef.current) {
          setCursorPosition(editorRef.current, savedCursorPos);
        }
      }
    }
    isInternalChange.current = false;
  }, [content, linkNamesSize]);
  
  // Initialize content on mount
  useEffect(() => {
    if (editorRef.current) {
      const html = contentToHtml(content, linkNames);
      editorRef.current.innerHTML = html || '<br>';
      // Focus and set cursor
      editorRef.current.focus();
      if (initialCursorPosition !== undefined && !initialCursorApplied.current) {
        setCursorPosition(editorRef.current, initialCursorPosition);
        initialCursorApplied.current = true;
      } else {
        // Position cursor at end
        const range = document.createRange();
        range.selectNodeContents(editorRef.current);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only on mount
  
  const [trigger, setTrigger] = useState<TriggerState>({
    isOpen: false,
    type: 'type',
    query: '',
    triggerPosition: 0,
    position: { top: 0, left: 0 },
  });
  
  // Slash command state
  const [slashCommand, setSlashCommand] = useState<{
    isOpen: boolean;
    query: string;
    triggerPosition: number;
    position: { top: number; left: number };
  }>({
    isOpen: false,
    query: '',
    triggerPosition: 0,
    position: { top: 0, left: 0 },
  });
  


  // Handle input changes
  const handleInput = useCallback(() => {
    if (!editorRef.current || isComposing) return;
    
    // Extract plain text content
    const newContent = htmlToContent(editorRef.current);
    
    if (newContent !== lastContentRef.current) {
      isInternalChange.current = true;
      lastContentRef.current = newContent;
      onChange(newContent);
      
      // Check for triggers
      checkTriggers(newContent);
    }
  }, [isComposing, onChange]);
  
  // Check for trigger characters
  const checkTriggers = useCallback((text: string) => {
    if (readOnly || !editorRef.current) return;
    
    const cursorPos = getCursorPosition(editorRef.current);
    if (cursorPos === 0) {
      setTrigger(prev => prev.isOpen ? { ...prev, isOpen: false } : prev);
      setSlashCommand(prev => prev.isOpen ? { ...prev, isOpen: false } : prev);
      return;
    }
    
    const textBeforeCursor = text.substring(0, cursorPos);
    
    // Check for slash command trigger first
    const lastSlashIndex = textBeforeCursor.lastIndexOf('/');
    if (lastSlashIndex >= 0 && (lastSlashIndex === 0 || /\s/.test(textBeforeCursor[lastSlashIndex - 1]))) {
      const slashQuery = textBeforeCursor.substring(lastSlashIndex + 1);
      // Only show slash commands if no whitespace in query
      if (!/\s/.test(slashQuery)) {
        const coords = getCaretCoordinates(editorRef.current);
        
        setSlashCommand({
          isOpen: true,
          query: slashQuery,
          triggerPosition: lastSlashIndex,
          position: coords,
        });
        setTrigger(prev => prev.isOpen ? { ...prev, isOpen: false } : prev);
        return;
      }
    }
    
    // Close slash command if no longer valid
    setSlashCommand(prev => prev.isOpen ? { ...prev, isOpen: false } : prev);
    
    // Find all trigger positions
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');
    const lastHashIndex = textBeforeCursor.lastIndexOf('#');
    const lastLinkIndex = textBeforeCursor.lastIndexOf('[[');
    
    // Find which trigger is most recent and valid
    type TriggerInfo = { type: SuggestionType; index: number; length: number };
    const triggers: TriggerInfo[] = [];
    
    // @ trigger (must be at start or after whitespace)
    if (lastAtIndex >= 0 && (lastAtIndex === 0 || /\s/.test(textBeforeCursor[lastAtIndex - 1]))) {
      triggers.push({ type: 'type', index: lastAtIndex, length: 1 });
    }
    
    // # trigger (must be at start or after whitespace)
    if (lastHashIndex >= 0 && (lastHashIndex === 0 || /\s/.test(textBeforeCursor[lastHashIndex - 1]))) {
      triggers.push({ type: 'tag', index: lastHashIndex, length: 1 });
    }
    
    // [[ trigger - check it's not closed yet
    if (lastLinkIndex >= 0) {
      const afterBracket = textBeforeCursor.substring(lastLinkIndex + 2);
      if (!afterBracket.includes(']]')) {
        triggers.push({ type: 'link', index: lastLinkIndex, length: 2 });
      }
    }
    
    // Find the most recent trigger
    const activeTrigger = triggers.reduce<TriggerInfo | null>((best, current) => {
      if (!best || current.index > best.index) return current;
      return best;
    }, null);
    
    if (activeTrigger) {
      const query = textBeforeCursor.substring(activeTrigger.index + activeTrigger.length);
      
      // For @ and #, only show if query doesn't contain whitespace
      // For [[, allow spaces in the query
      const isValidQuery = activeTrigger.type === 'link'
        ? true
        : !/\s/.test(query);
      
      if (isValidQuery) {
        const coords = getCaretCoordinates(editorRef.current);
        
        setTrigger({
          isOpen: true,
          type: activeTrigger.type,
          query,
          triggerPosition: activeTrigger.index,
          position: coords,
        });
        return;
      }
    }
    
    // Close popup if no active trigger
    setTrigger(prev => prev.isOpen ? { ...prev, isOpen: false } : prev);
  }, [readOnly]);

  // Handle keydown for navigation and deletion
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!editorRef.current) return;
    
    const currentContent = htmlToContent(editorRef.current);
    const cursorPos = getCursorPosition(editorRef.current);
    
    // Handle pill deletion
    if (selectedPill && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
      
      // Remove the pill from DOM
      const parent = selectedPill.parentNode;
      if (parent) {
        selectedPill.remove();
        setSelectedPill(null);
        
        // Update content
        const newContent = htmlToContent(editorRef.current);
        isInternalChange.current = true;
        lastContentRef.current = newContent;
        onChange(newContent);
      }
      return;
    }
    
    // Clear selected pill on typing
    if (selectedPill && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      selectedPill.classList.remove('link-pill--selected');
      setSelectedPill(null);
    }

    // Shift+Enter cycles task state for task blocks
    if (e.shiftKey && e.key === 'Enter' && isTask && onTaskStateChange) {
      e.preventDefault();
      const currentIndex = taskState ? TASK_STATES.indexOf(taskState) : -1;
      const nextIndex = (currentIndex + 1) % TASK_STATES.length;
      onTaskStateChange(TASK_STATES[nextIndex]);
      return;
    }

    // Enter (without modifiers) creates a new block
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Don't handle if a popup is open
      if (trigger.isOpen || slashCommand.isOpen) return;
      
      e.preventDefault();
      if (onEnterCreateBlock) {
        const textBefore = currentContent.substring(0, cursorPos);
        const textAfter = currentContent.substring(cursorPos);
        onEnterCreateBlock(textBefore, textAfter);
      }
      return;
    }

    // Backspace at start of block - merge with block above
    if (e.key === 'Backspace' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (cursorPos === 0 && currentContent.length > 0 && onBackspaceAtStart) {
        e.preventDefault();
        onBackspaceAtStart(currentContent);
        return;
      }
    }

    // Delete at end of block - merge with block below
    if (e.key === 'Delete' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (cursorPos === currentContent.length && onDeleteAtEnd) {
        e.preventDefault();
        onDeleteAtEnd();
        return;
      }
    }

    // Ctrl+C with no selection copies the block link
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      const selection = window.getSelection();
      const hasSelection = selection && !selection.isCollapsed;
      if (!hasSelection && nodeUuid) {
        e.preventDefault();
        const blockLink = `((${nodeUuid}))`;
        navigator.clipboard.writeText(blockLink);
        return;
      }
    }

    // Escape exits edit mode
    if (e.key === 'Escape') {
      e.preventDefault();
      editorRef.current.blur();
      onEscape?.();
      return;
    }

    // Tab / Shift+Tab for indent/outdent
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

    // Shift+Arrow extends selection
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      onExtendSelection?.(e.key === 'ArrowUp' ? 'up' : 'down');
      return;
    }

    // Arrow navigation around pills
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      handleArrowNavigation(e);
    }

    // Arrow up at beginning of text navigates to previous block
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (cursorPos === 0) {
        e.preventDefault();
        onNavigateUp?.();
        return;
      }
    }

    // Arrow down at end of text navigates to next block
    if (e.key === 'ArrowDown' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (cursorPos === currentContent.length) {
        e.preventDefault();
        onNavigateDown?.();
        return;
      }
    }
  }, [selectedPill, onChange, onEscape, onNavigateUp, onNavigateDown, onExtendSelection, isTask, taskState, onTaskStateChange, onEnterCreateBlock, onBackspaceAtStart, onDeleteAtEnd, onIndent, onOutdent, trigger.isOpen, slashCommand.isOpen, nodeUuid]);
  
  // Handle arrow navigation around pills
  const handleArrowNavigation = useCallback((e: React.KeyboardEvent) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    
    const range = selection.getRangeAt(0);
    const direction = e.key === 'ArrowLeft' ? 'left' : 'right';
    
    // If a pill is selected, move cursor past it
    if (selectedPill) {
      e.preventDefault();
      selectedPill.classList.remove('link-pill--selected');
      setSelectedPill(null);
      
      const parent = selectedPill.parentNode;
      if (parent) {
        const newRange = document.createRange();
        const index = Array.from(parent.childNodes).indexOf(selectedPill as ChildNode);
        if (direction === 'left') {
          // Move cursor before the pill
          const prevNode = selectedPill.previousSibling;
          if (prevNode && prevNode.nodeType === Node.TEXT_NODE) {
            // Position at end of previous text node
            newRange.setStart(prevNode, prevNode.textContent?.length || 0);
          } else {
            newRange.setStart(parent, index);
          }
        } else {
          // Move cursor after the pill - look for text node (ZWS) after the pill
          const nextNode = selectedPill.nextSibling;
          if (nextNode && nextNode.nodeType === Node.TEXT_NODE) {
            // Position at start of next text node (which may be ZWS)
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
      // Check if we're at the start of a text node
      const container = range.startContainer;
      if (container.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
        // Check previous sibling
        let prev = container.previousSibling;
        if (!prev && container.parentNode !== editorRef.current) {
          prev = container.parentNode?.previousSibling || null;
        }
        if (prev && (prev as HTMLElement).classList?.contains('link-pill')) {
          adjacentPill = prev as HTMLElement;
        }
      } else if (container.nodeType === Node.TEXT_NODE) {
        // Check if we're in a ZWS-only text node at position <= 1
        const text = container.textContent || '';
        if (text === '\u200B' && range.startOffset <= 1) {
          // We're in a ZWS, check previous sibling for a pill
          let prev = container.previousSibling;
          if (prev && (prev as HTMLElement).classList?.contains('link-pill')) {
            adjacentPill = prev as HTMLElement;
          }
        }
      }
    } else if (direction === 'right') {
      // Check next sibling
      const container = range.startContainer;
      if (container.nodeType === Node.TEXT_NODE && 
          range.startOffset === (container.textContent?.length || 0)) {
        let next = container.nextSibling;
        if (next && (next as HTMLElement).classList?.contains('link-pill')) {
          adjacentPill = next as HTMLElement;
        }
      } else if (container === editorRef.current) {
        // Cursor might be between nodes
        const childIndex = range.startOffset;
        const child = container.childNodes[childIndex];
        if (child && (child as HTMLElement).classList?.contains('link-pill')) {
          adjacentPill = child as HTMLElement;
        }
      }
    }
    
    if (adjacentPill) {
      e.preventDefault();
      // Select the pill (no need to deselect old pill since we return early if one is selected)
      adjacentPill.classList.add('link-pill--selected');
      setSelectedPill(adjacentPill);
    }
  }, [selectedPill]);

  // Handle selection from popup
  const handleSelect = useCallback((node: Node, keepInline: boolean) => {
    if (!editorRef.current) return;
    
    const currentContent = htmlToContent(editorRef.current);
    const textBeforeTrigger = currentContent.substring(0, trigger.triggerPosition);
    const cursorPos = getCursorPosition(editorRef.current);
    const textAfterCursor = currentContent.substring(cursorPos);
    
    let newContent: string;
    
    if (trigger.type === 'link') {
      // Use node ID for the link
      const linkText = `[[${node.id}]]`;
      newContent = textBeforeTrigger + linkText + ' ' + textAfterCursor;
      onLinkPage?.(node);  // Callback for any link (page or block)
    } else if (keepInline) {
      const inlineText = trigger.type === 'type' 
        ? `@${node.name}` 
        : `#${node.name}`;
      newContent = textBeforeTrigger + inlineText + ' ' + textAfterCursor;
      
      if (trigger.type === 'type' && onAddType) {
        onAddType(node.id, keepInline, node.name || '');
      } else if (trigger.type === 'tag' && onAddTag) {
        onAddTag(node.id, keepInline, node.name || '');
      }
    } else {
      newContent = textBeforeTrigger + textAfterCursor.trimStart();
      
      if (trigger.type === 'type' && onAddType) {
        onAddType(node.id, keepInline, node.name || '');
      } else if (trigger.type === 'tag' && onAddTag) {
        onAddTag(node.id, keepInline, node.name || '');
      }
    }
    
    // Calculate cursor position after the inserted content
    let cursorTargetPos: number;
    if (trigger.type === 'link') {
      const linkText = `[[${node.id}]]`;
      cursorTargetPos = textBeforeTrigger.length + linkText.length + 1; // +1 for space
    } else if (keepInline) {
      const inlineText = trigger.type === 'type' ? `@${node.name}` : `#${node.name}`;
      cursorTargetPos = textBeforeTrigger.length + inlineText.length + 1;
    } else {
      cursorTargetPos = textBeforeTrigger.length;
    }
    
    isInternalChange.current = true;
    lastContentRef.current = newContent;
    onChange(newContent);
    
    // Create updated linkNames map that includes the just-inserted node
    const updatedLinkNames = new Map(linkNames);
    if (trigger.type === 'link') {
      updatedLinkNames.set(String(node.id), {
        name: node.name || node.display_name || 'Untitled',
        isPage: node.is_page || node.parent_id === null,
      });
    }
    
    // Update HTML with the updated map
    const html = contentToHtml(newContent, updatedLinkNames);
    editorRef.current.innerHTML = html || '<br>';
    
    setTrigger(prev => ({ ...prev, isOpen: false }));
    
    // Refocus and position cursor after the inserted link
    setTimeout(() => {
      if (editorRef.current) {
        editorRef.current.focus();
        setCursorPosition(editorRef.current, cursorTargetPos);
      }
    }, 0);
  }, [trigger, onChange, onAddType, onAddTag, onLinkPage, linkNames]);

  // Handle create new type/tag/link
  const handleCreate = useCallback(async (name: string, keepInline: boolean) => {
    if (!editorRef.current) return;
    
    const currentContent = htmlToContent(editorRef.current);
    const textBeforeTrigger = currentContent.substring(0, trigger.triggerPosition);
    const cursorPos = getCursorPosition(editorRef.current);
    const textAfterCursor = currentContent.substring(cursorPos);
    
    let newContent: string;
    let cursorTargetPos: number;
    let newPageId: string | undefined;
    
    if (trigger.type === 'link') {
      // Create the page and get the new page ID
      newPageId = await onCreatePageLink?.(name);
      if (newPageId) {
        const linkText = `[[${newPageId}]]`;
        newContent = textBeforeTrigger + linkText + ' ' + textAfterCursor;
        cursorTargetPos = textBeforeTrigger.length + linkText.length + 1;
      } else {
        // Fallback if no ID returned
        newContent = textBeforeTrigger + textAfterCursor.trimStart();
        cursorTargetPos = textBeforeTrigger.length;
      }
    } else if (keepInline) {
      const inlineText = trigger.type === 'type' ? `@${name}` : `#${name}`;
      newContent = textBeforeTrigger + inlineText + ' ' + textAfterCursor;
      cursorTargetPos = textBeforeTrigger.length + inlineText.length + 1;
      
      if (trigger.type === 'type' && onCreateType) {
        onCreateType(name, keepInline);
      } else if (trigger.type === 'tag' && onCreateTag) {
        onCreateTag(name, keepInline);
      }
    } else {
      newContent = textBeforeTrigger + textAfterCursor.trimStart();
      cursorTargetPos = textBeforeTrigger.length;
      
      if (trigger.type === 'type' && onCreateType) {
        onCreateType(name, keepInline);
      } else if (trigger.type === 'tag' && onCreateTag) {
        onCreateTag(name, keepInline);
      }
    }
    
    isInternalChange.current = true;
    lastContentRef.current = newContent;
    onChange(newContent);
    
    // Create updated linkNames map that includes the just-created page
    const updatedLinkNames = new Map(linkNames);
    if (trigger.type === 'link' && newPageId) {
      updatedLinkNames.set(newPageId, {
        name: name,
        isPage: true,
      });
    }
    
    // Update HTML with the updated map
    const html = contentToHtml(newContent, updatedLinkNames);
    editorRef.current.innerHTML = html || '<br>';
    
    setTrigger(prev => ({ ...prev, isOpen: false }));
    
    // Refocus and position cursor after the inserted content
    setTimeout(() => {
      if (editorRef.current) {
        editorRef.current.focus();
        setCursorPosition(editorRef.current, cursorTargetPos);
      }
    }, 0);
  }, [trigger, onChange, onCreateType, onCreateTag, onCreatePageLink, linkNames]);

  const handleClose = useCallback(() => {
    setTrigger(prev => ({ ...prev, isOpen: false }));
  }, []);

  // Handle slash command selection
  const handleSlashCommandSelect = useCallback((command: string) => {
    if (!editorRef.current) return;
    
    const currentContent = htmlToContent(editorRef.current);
    const textBeforeTrigger = currentContent.substring(0, slashCommand.triggerPosition);
    const cursorPos = getCursorPosition(editorRef.current);
    const textAfterCursor = currentContent.substring(cursorPos);
    
    // For link command, insert [[ and let checkTriggers handle it
    if (command === 'link') {
      const triggerText = '[[';
      const newContent = textBeforeTrigger + triggerText + textAfterCursor;
      isInternalChange.current = true;
      lastContentRef.current = newContent;
      onChange(newContent);
      
      // Update HTML
      const html = contentToHtml(newContent, linkNames);
      editorRef.current.innerHTML = html || '<br>';
      
      setSlashCommand(prev => ({ ...prev, isOpen: false }));
      
      // Position cursor after the trigger and let checkTriggers detect it
      setTimeout(() => {
        if (editorRef.current) {
          editorRef.current.focus();
          setCursorPosition(editorRef.current, slashCommand.triggerPosition + 2);
          // Trigger the check to show the suggestion popup
          checkTriggers(newContent);
        }
      }, 0);
      return;
    }
    
    // Remove the slash and query
    const newContent = textBeforeTrigger + textAfterCursor.trimStart();
    isInternalChange.current = true;
    lastContentRef.current = newContent;
    onChange(newContent);
    
    // Update HTML
    const html = contentToHtml(newContent, linkNames);
    editorRef.current.innerHTML = html || '<br>';
    
    // Execute the command
    if (command === 'comment' && onOpenComments) {
      onOpenComments();
    } else if (command === 'image' && onAssetUpload) {
      onAssetUpload(['image']);
    } else if (command === 'audio' && onAssetUpload) {
      onAssetUpload(['audio']);
    } else if (command === 'file' && onAssetUpload) {
      onAssetUpload();
    }
    
    setSlashCommand(prev => ({ ...prev, isOpen: false }));
    
    setTimeout(() => editorRef.current?.focus(), 0);
  }, [slashCommand.triggerPosition, onChange, onOpenComments, onAssetUpload, linkNames]);

  const handleSlashCommandClose = useCallback(() => {
    setSlashCommand(prev => ({ ...prev, isOpen: false }));
  }, []);

  // Handle paste events
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    // Prevent default paste to avoid HTML insertion
    e.preventDefault();
    
    // Get plain text
    const text = e.clipboardData?.getData('text/plain') || '';
    
    // Check for files
    const items = e.clipboardData?.items;
    if (items && onAssetUpload) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            const isImage = file.type.startsWith('image/');
            const isAudio = file.type.startsWith('audio/');
            if (isImage || isAudio) {
              onAssetUpload(file);
              return;
            }
          }
        }
      }
    }
    
    // Insert plain text at cursor
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      
      // Trigger input handler
      handleInput();
    }
  }, [onAssetUpload, handleInput]);

  // Update popup position on scroll/resize
  useEffect(() => {
    if ((!trigger.isOpen && !slashCommand.isOpen) || !editorRef.current) return;
    
    const updatePosition = () => {
      if (editorRef.current) {
        const coords = getCaretCoordinates(editorRef.current);
        if (trigger.isOpen) {
          setTrigger(prev => ({ ...prev, position: coords }));
        }
        if (slashCommand.isOpen) {
          setSlashCommand(prev => ({ ...prev, position: coords }));
        }
      }
    };
    
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [trigger.isOpen, slashCommand.isOpen]);

  return (
    <div className="block-editor">
      <div
        ref={editorRef}
        className="block-editor-input"
        contentEditable={!readOnly}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => {
          setIsComposing(false);
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
          />
          
          <SlashCommandPopup
            isOpen={slashCommand.isOpen}
            query={slashCommand.query}
            position={slashCommand.position}
            onSelect={handleSlashCommandSelect}
            onClose={handleSlashCommandClose}
          />
        </>
      )}
    </div>
  );
}
