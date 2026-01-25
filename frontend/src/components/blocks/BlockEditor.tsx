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
 * Selection Model (Model-First):
 * - Selection state is stored centrally in blockSelectionStore (not DOM)
 * - DOM selection is a PROJECTION of the model selection
 * - Uses useLayoutEffect for selection restoration (runs before paint)
 * - Supports pendingSelection for stable cursor after mutations
 * 
 * Note: This component is the pure editor. The bullet point and comment 
 * indicator are rendered by the parent Block component.
 */
import { useRef, useCallback, useState, useEffect, useLayoutEffect, useMemo } from 'react';
import './BlockEditor.css';
import { SuggestionPopup, type SuggestionType } from '../SuggestionPopup';
import { SlashCommandPopup } from '../SlashCommandPopup';
import { useNodes, useTextLinks, useClasses } from '@/hooks';
import { usePendingSelectionForBlock, useEditorSelectionActions } from '@/stores/selectors';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { mdiTag } from '@mdi/js';
import * as mdiIcons from '@mdi/js';
import type { Node } from '@/types';

/**
 * Convert an icon name to an MDI SVG path
 * Accepts formats: "mdi-calendar-today", "mdiCalendarToday", "calendar-today", "calendarToday"
 */
function getMdiPath(iconName: string): string | null {
  // Normalize: remove "mdi-" prefix, convert kebab-case to camelCase
  let normalized = iconName
    .replace(/^mdi-?/i, '')  // Remove mdi- or mdi prefix
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());  // kebab to camelCase
  
  // Ensure first letter is lowercase, then prepend "mdi"
  normalized = 'mdi' + normalized.charAt(0).toUpperCase() + normalized.slice(1);
  
  // Look up in the mdiIcons object
  const path = (mdiIcons as Record<string, string>)[normalized];
  return path || null;
}

/**
 * Check if a string is likely an emoji (not an MDI-like pattern)
 */
function isEmoji(icon: string): boolean {
  // Emojis typically don't match MDI patterns and are short
  return !icon.match(/^mdi/i) && !icon.match(/^[a-z-]+$/i) && !icon.startsWith('M');
}

/**
 * Render an icon as HTML for contenteditable
 * Handles: emoji, MDI icon names, and raw SVG paths
 */
function renderIconHtml(icon: string, size: number = 14.4): string {
  // Check if it's an emoji
  if (isEmoji(icon)) {
    return `<span class="link-pill__icon" style="font-size: ${size}px; line-height: 1; display: inline-flex; align-items: center; justify-content: center;">${icon}</span>`;
  }
  
  // Check if it's already an SVG path (starts with M for moveto command)
  let svgPath = icon;
  if (!icon.startsWith('M')) {
    // Try to resolve as MDI icon name
    const mdiPath = getMdiPath(icon);
    if (!mdiPath) {
      // Could not resolve - don't show icon
      return '';
    }
    svgPath = mdiPath;
  }
  
  // Render as SVG
  const iconSvg = `<svg viewBox="0 0 24 24" style="width: ${size}px; height: ${size}px;"><path fill="currentColor" d="${svgPath}"></path></svg>`;
  return `<span class="link-pill__icon">${iconSvg}</span>`;
}

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
  onAddClass?: (classNodeId: number, keepInline: boolean, className: string) => void;
  onAddTag?: (tagNodeId: number, keepInline: boolean, tagName: string) => void;
  onCreateClass?: (name: string, keepInline: boolean) => void;
  onCreateTag?: (name: string, keepInline: boolean) => void;
  onLinkPage?: (pageNode: Node) => void;
  onCreatePageLink?: (name: string) => Promise<string | undefined>;  // Returns the new page ID
  onOpenComments?: () => void;
  /** Callback for asset upload. Can pass types filter or a file to upload directly */
  onAssetUpload?: (assetTypesOrFile?: ('image' | 'audio' | 'file')[] | File) => void;
  readOnly?: boolean;
  /** Called when user presses Escape to exit edit mode */
  onEscape?: () => void;
  /** Called when user presses arrow up at beginning/first line. Receives caretX for position preservation. */
  onNavigateUp?: (caretX?: number) => void;
  /** Called when user presses arrow down at end/last line. Receives caretX for position preservation. */
  onNavigateDown?: (caretX?: number) => void;
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

interface InlineTypeInfo {
  typeId: string;  // The type node ID
  start: number;
  end: number;
  raw: string;
}

/**
 * Parse content to find all inline types - {{typeId}} format
 */
function parseInlineTypes(content: string): InlineTypeInfo[] {
  const types: InlineTypeInfo[] = [];
  
  // Find all inline types {{id}}
  let match;
  const typeRegex = /\{\{([^\}]+)\}\}/g;
  while ((match = typeRegex.exec(content)) !== null) {
    types.push({
      typeId: match[1],
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
    });
  }
  
  // Sort by position
  types.sort((a, b) => a.start - b.start);
  
  return types;
}

interface PillInfo {
  type: 'link' | 'inline-type';
  id: string;
  start: number;
  end: number;
  raw: string;
}

/**
 * Parse content to find all pills (links and inline types)
 */
function parseAllPills(content: string): PillInfo[] {
  const pills: PillInfo[] = [];
  
  // Parse links
  for (const link of parseLinks(content)) {
    pills.push({
      type: 'link',
      id: link.linkId,
      start: link.start,
      end: link.end,
      raw: link.raw,
    });
  }
  
  // Parse inline types
  for (const inlineType of parseInlineTypes(content)) {
    pills.push({
      type: 'inline-type',
      id: inlineType.typeId,
      start: inlineType.start,
      end: inlineType.end,
      raw: inlineType.raw,
    });
  }
  
  // Sort by position
  pills.sort((a, b) => a.start - b.start);
  
  return pills;
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
 * Convert plain text content with link and inline type markers to HTML with pill elements
 * 
 * Link pills display:
 * - Icon: Only shown if getEffectiveIcon returns a value (node's own icon or inherited from types)
 * - No icon/bullet: If getEffectiveIcon returns null/undefined
 * 
 * @param content - The raw content with [[linkId]] and {{typeId}} markers
 * @param linkNames - Map of linkId -> {name, isPage, isTag, clickCount, effectiveIcon} for display
 * @param typeNames - Map of typeId -> {name, icon} for display
 */
function contentToHtml(
  content: string, 
  linkNames: Map<string, { name: string; isPage: boolean; isTag?: boolean; clickCount?: number; effectiveIcon?: string | null }>,
  typeNames?: Map<string, { name: string; icon?: string }>
): string {
  const pills = parseAllPills(content);
  
  if (pills.length === 0) {
    return escapeHtml(content);
  }
  
  let html = '';
  let lastEnd = 0;
  
  for (const pill of pills) {
    // Add text before this pill
    if (pill.start > lastEnd) {
      html += escapeHtml(content.substring(lastEnd, pill.start));
    }
    
    if (pill.type === 'link') {
      // Look up the link info
      const linkInfo = linkNames.get(pill.id);
      const displayText = linkInfo?.name || pill.id;
      const isPage = linkInfo?.isPage ?? true;
      const isTag = linkInfo?.isTag ?? false;
      const clickCount = linkInfo?.clickCount ?? 0;
      // effectiveIcon is computed from getEffectiveIcon - includes node's icon or type-inherited icon
      const effectiveIcon = linkInfo?.effectiveIcon;
      
      if (isTag) {
        // Render as tag pill with hashtag icon
        const iconPath = mdiTag;
        const iconSvg = `<svg viewBox="0 0 24 24" style="width: 14.4px; height: 14.4px;"><path fill="currentColor" d="${iconPath}"></path></svg>`;
        const icon = `<span class="tag-pill__icon">${iconSvg}</span>`;
        
        html += `<span class="tag-pill" contenteditable="false" data-link-id="${escapeAttr(pill.id)}" data-link-raw="${escapeAttr(pill.raw)}" data-is-tag="true">${icon}<span class="tag-pill__text">${escapeHtml(displayText)}</span></span>`;
      } else {
        // Render as regular link pill - true inline atomic node
        const pillClass = isPage ? 'link-pill--page' : 'link-pill--block';
        
        // Only show icon if getEffectiveIcon returns a value
        // Use renderIconHtml to handle emoji, MDI icon names, and SVG paths
        let icon = '';
        if (effectiveIcon) {
          icon = renderIconHtml(effectiveIcon);
        }
        // No icon (or failed to render) = no icon shown (true inline text-style pill)
        const hasIcon = icon.length > 0;
        
        const badge = clickCount > 0 
          ? `<span class="link-pill__badge">${clickCount}</span>` 
          : '';
        
        // Add data-node-id and data-label for proper serialization
        html += `<span class="link-pill ${pillClass}${!hasIcon ? ' link-pill--no-icon' : ''}" contenteditable="false" data-link-id="${escapeAttr(pill.id)}" data-link-raw="${escapeAttr(pill.raw)}" data-node-id="${escapeAttr(pill.id)}" data-label="${escapeAttr(displayText)}">${icon}<span class="link-pill__text">${escapeHtml(displayText)}</span>${badge}</span>`;
      }
    } else {
      // Inline type pill
      const typeInfo = typeNames?.get(pill.id);
      const displayText = typeInfo?.name || pill.id;
      // Use tag icon for types, or custom icon if available
      const iconPath = mdiTag;
      const iconSvg = `<svg viewBox="0 0 24 24" style="width: 14.4px; height: 14.4px;"><path fill="currentColor" d="${iconPath}"></path></svg>`;
      const icon = `<span class="type-pill__icon">${iconSvg}</span>`;
      
      html += `<span class="type-pill" contenteditable="false" data-type-id="${escapeAttr(pill.id)}" data-type-raw="${escapeAttr(pill.raw)}">${icon}<span class="type-pill__text">${escapeHtml(displayText)}</span></span>`;
    }
    
    // Add zero-width space after pill if no text follows immediately
    // This ensures the cursor has a text node to anchor to when navigating
    const nextChar = content[pill.end];
    if (!nextChar || nextChar === '[' || nextChar === '{') {
      html += '\u200B';
    }
    
    lastEnd = pill.end;
  }
  
  // Add remaining text
  if (lastEnd < content.length) {
    html += escapeHtml(content.substring(lastEnd));
  } else if (pills.length > 0) {
    // Ensure there's a ZWS at the end if content ends with a pill
    html += '\u200B';
  }
  
  return html;
}

/**
 * Convert HTML back to plain text content with link and type markers
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
      } else if (el.classList.contains('type-pill')) {
        // Get the raw type text from data attribute
        content += el.dataset.typeRaw || '';
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
 * Check if an element is a pill (link, type, or tag)
 */
function isPillElement(el: HTMLElement): boolean {
  return el.classList?.contains('link-pill') || 
         el.classList?.contains('type-pill') || 
         el.classList?.contains('tag-pill');
}

/**
 * Get the raw content length of a pill element
 */
function getPillRawLength(el: HTMLElement): number {
  if (el.classList?.contains('link-pill') || el.classList?.contains('tag-pill')) {
    return (el.dataset.linkRaw || '').length;
  } else if (el.classList?.contains('type-pill')) {
    return (el.dataset.typeRaw || '').length;
  }
  return 0;
}

/**
 * Get cursor position in plain text content
 * Ignores zero-width spaces (\u200B) that are added for cursor positioning
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
      // Count characters up to the cursor position, excluding ZWS
      const textBeforeCursor = (node.textContent || '').substring(0, range.startOffset);
      position += textBeforeCursor.replace(/\u200B/g, '').length;
      break;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      // Count text length excluding ZWS
      position += (node.textContent || '').replace(/\u200B/g, '').length;
    } else if (isPillElement(node as HTMLElement)) {
      position += getPillRawLength(node as HTMLElement);
      // Skip past this node's children
      walker.nextSibling();
    }
  }
  
  return position;
}

/**
 * Set cursor position in the contenteditable
 * targetPosition is in plain text coordinates (ZWS excluded)
 */
function setCursorPosition(element: HTMLElement, targetPosition: number): void {
  console.log('[setCursorPosition] targetPosition:', targetPosition, 'element:', element.textContent?.substring(0, 30));
  let currentPosition = 0;
  
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    null
  );
  
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const textContent = node.textContent || '';
      // Calculate length excluding ZWS for position tracking
      const contentLength = textContent.replace(/\u200B/g, '').length;
      
      if (currentPosition + contentLength >= targetPosition) {
        const range = document.createRange();
        // Calculate the actual DOM offset accounting for ZWS
        const targetOffsetInContent = targetPosition - currentPosition;
        let actualOffset = 0;
        let contentCharsCount = 0;
        
        for (let i = 0; i < textContent.length && contentCharsCount < targetOffsetInContent; i++) {
          if (textContent[i] !== '\u200B') {
            contentCharsCount++;
          }
          actualOffset = i + 1;
        }
        
        // If we're at the start and there's a leading ZWS, skip past it
        if (actualOffset === 0 && textContent[0] === '\u200B') {
          actualOffset = 1;
        }
        
        console.log('[setCursorPosition] Found text node, actualOffset:', actualOffset, 'text:', textContent.substring(0, 20));
        range.setStart(node, Math.min(actualOffset, textContent.length));
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      currentPosition += contentLength;
    } else if (isPillElement(node as HTMLElement)) {
      const length = getPillRawLength(node as HTMLElement);
      if (currentPosition + length >= targetPosition) {
        console.log('[setCursorPosition] Found pill, positioning after it');
        // Position cursor after this pill - find the next text node
        const range = document.createRange();
        const nextSibling = node.nextSibling;
        
        // If there's a text node after the pill, position after any leading ZWS
        if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
          const text = nextSibling.textContent || '';
          // Skip past leading ZWS
          const offset = text[0] === '\u200B' ? 1 : 0;
          range.setStart(nextSibling, offset);
        } else {
          // Fallback: position after the pill in the parent
          const parent = node.parentNode;
          if (parent) {
            const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
            range.setStart(parent, index + 1);
          }
        }
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      currentPosition += length;
    }
  }
  
  console.log('[setCursorPosition] Target past content, positioning at end');
  // Position at end if target is past content
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * Find the character offset that best matches a target X position in the last line of an element.
 * Used for preserving horizontal caret position during ArrowUp navigation.
 * 
 * @param element - The contenteditable element
 * @param targetX - The target X coordinate (in viewport pixels)
 * @returns The character offset that is closest to targetX on the last line
 */
function findOffsetAtXInLastLine(element: HTMLElement, targetX: number): number {
  const text = element.textContent || '';
  if (!text) return 0;
  
  const range = document.createRange();
  let bestOffset = text.length;
  let bestDistance = Infinity;
  let lastLineY = -Infinity;
  
  // First pass: find the Y coordinate of the last line
  const contentLength = text.replace(/\u200B/g, '').length;
  for (let i = 0; i <= contentLength; i++) {
    try {
      setCursorPositionSilent(element, i, range);
      const rect = range.getBoundingClientRect();
      if (rect.top > lastLineY) {
        lastLineY = rect.top;
      }
    } catch {
      // Ignore errors from invalid positions
    }
  }
  
  // Second pass: find the offset with X closest to targetX on the last line
  const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 24;
  for (let i = 0; i <= contentLength; i++) {
    try {
      setCursorPositionSilent(element, i, range);
      const rect = range.getBoundingClientRect();
      
      // Only consider positions on the last line (within 0.5 line height)
      if (Math.abs(rect.top - lastLineY) < lineHeight * 0.5) {
        const distance = Math.abs(rect.left - targetX);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestOffset = i;
        }
      }
    } catch {
      // Ignore errors from invalid positions
    }
  }
  
  return bestOffset;
}

/**
 * Find the character offset that best matches a target X position in the first line of an element.
 * Used for preserving horizontal caret position during ArrowDown navigation.
 * 
 * @param element - The contenteditable element
 * @param targetX - The target X coordinate (in viewport pixels)
 * @returns The character offset that is closest to targetX on the first line
 */
function findOffsetAtXInFirstLine(element: HTMLElement, targetX: number): number {
  const text = element.textContent || '';
  if (!text) return 0;
  
  const range = document.createRange();
  let bestOffset = 0;
  let bestDistance = Infinity;
  let firstLineY = Infinity;
  
  // First pass: find the Y coordinate of the first line
  const contentLength = text.replace(/\u200B/g, '').length;
  for (let i = 0; i <= contentLength; i++) {
    try {
      setCursorPositionSilent(element, i, range);
      const rect = range.getBoundingClientRect();
      if (rect.top < firstLineY) {
        firstLineY = rect.top;
      }
    } catch {
      // Ignore errors from invalid positions
    }
  }
  
  // Second pass: find the offset with X closest to targetX on the first line
  const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 24;
  for (let i = 0; i <= contentLength; i++) {
    try {
      setCursorPositionSilent(element, i, range);
      const rect = range.getBoundingClientRect();
      
      // Only consider positions on the first line (within 0.5 line height)
      if (Math.abs(rect.top - firstLineY) < lineHeight * 0.5) {
        const distance = Math.abs(rect.left - targetX);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestOffset = i;
        }
      }
    } catch {
      // Ignore errors from invalid positions
    }
  }
  
  return bestOffset;
}

/**
 * Set cursor position without triggering selection changes.
 * Used internally for measuring positions.
 */
function setCursorPositionSilent(element: HTMLElement, targetPosition: number, range: Range): void {
  let currentPosition = 0;
  
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    null
  );
  
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const textContent = node.textContent || '';
      const contentLength = textContent.replace(/\u200B/g, '').length;
      
      if (currentPosition + contentLength >= targetPosition) {
        const targetOffsetInContent = targetPosition - currentPosition;
        let actualOffset = 0;
        let contentCharsCount = 0;
        
        for (let i = 0; i < textContent.length && contentCharsCount < targetOffsetInContent; i++) {
          if (textContent[i] !== '\u200B') {
            contentCharsCount++;
          }
          actualOffset = i + 1;
        }
        
        if (actualOffset === 0 && textContent[0] === '\u200B') {
          actualOffset = 1;
        }
        
        range.setStart(node, Math.min(actualOffset, textContent.length));
        range.collapse(true);
        return;
      }
      currentPosition += contentLength;
    } else if (isPillElement(node as HTMLElement)) {
      const length = getPillRawLength(node as HTMLElement);
      if (currentPosition + length >= targetPosition) {
        const nextSibling = node.nextSibling;
        if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
          const text = nextSibling.textContent || '';
          const offset = text[0] === '\u200B' ? 1 : 0;
          range.setStart(nextSibling, offset);
        } else {
          const parent = node.parentNode;
          if (parent) {
            const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
            range.setStart(parent, index + 1);
          }
        }
        range.collapse(true);
        return;
      }
      currentPosition += length;
    }
  }
  
  // Position at end
  range.selectNodeContents(element);
  range.collapse(false);
}

/**
 * Get the current caret's X position in viewport coordinates.
 * Returns undefined if no selection or selection is not collapsed.
 */
function getCaretX(): number | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return undefined;
  }
  
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  
  // Use left position, or fallback to the range's collapsed position
  return rect.left || rect.right;
}

export function BlockEditor({ 
  nodeId,
  isPage,
  nodeUuid,
  content, 
  onChange,
  onAddClass,
  onAddTag,
  onCreateClass,
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
  
  // === Model-First Selection Support ===
  // Get pending selection for this block from the store
  const pendingSelection = usePendingSelectionForBlock(nodeId ?? -1);
  const { clearPendingSelection } = useEditorSelectionActions();
  
  // useLayoutEffect for selection restoration - runs synchronously after DOM mutations
  // but BEFORE browser paints, preventing visual cursor jumps
  useLayoutEffect(() => {
    if (!pendingSelection || !editorRef.current) return;
    
    // Only restore if this block should have focus
    if (pendingSelection.anchorBlockId !== nodeId) return;
    
    // Focus the editor if not already focused
    if (document.activeElement !== editorRef.current) {
      editorRef.current.focus();
    }
    
    // If caretX is provided, use it to find the best offset position
    // This preserves horizontal position during ArrowUp/Down navigation
    if (pendingSelection.caretX !== undefined) {
      // For ArrowUp navigation (coming from below), find position in last line
      // For ArrowDown navigation (coming from above), find position in first line
      // We determine direction based on offset: 0 = coming from above, length = coming from below
      const contentLength = (editorRef.current.textContent || '').replace(/\u200B/g, '').length;
      
      let targetOffset: number;
      if (pendingSelection.anchorOffset === 0) {
        // Coming from ArrowDown (from block above), find position in first line
        targetOffset = findOffsetAtXInFirstLine(editorRef.current, pendingSelection.caretX);
      } else if (pendingSelection.anchorOffset >= contentLength) {
        // Coming from ArrowUp (from block below), find position in last line
        targetOffset = findOffsetAtXInLastLine(editorRef.current, pendingSelection.caretX);
      } else {
        // Use the exact offset if it's in the middle
        targetOffset = pendingSelection.anchorOffset;
      }
      
      setCursorPosition(editorRef.current, targetOffset);
    } else {
      // No caretX, use the exact offset
      setCursorPosition(editorRef.current, pendingSelection.anchorOffset);
    }
    
    // Clear the pending selection
    clearPendingSelection();
  }, [pendingSelection, nodeId, clearPendingSelection]);
  
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
  
  // Extract inline type IDs from content
  const typeIds = useMemo(() => {
    const ids: string[] = [];
    const typeRegex = /\{\{([^\}]+)\}\}/g;
    let match;
    while ((match = typeRegex.exec(content)) !== null) {
      ids.push(match[1]);
    }
    return ids;
  }, [content]);
  
  // Fetch all nodes to get names for links and classes
  const { data: allNodes } = useNodes((linkIds.length > 0 || typeIds.length > 0) ? {} : null);
  
  // Fetch all class definitions to compute effective icons
  const { data: allClasses } = useClasses();
  
  // Fetch text links to know which are tags
  const { data: textLinks } = useTextLinks(nodeId ?? null);
  
  // Build a set of tag target IDs for quick lookup
  const tagTargetIds = useMemo(() => {
    const set = new Set<number>();
    if (textLinks) {
      for (const link of textLinks) {
        if (link.is_tag) {
          set.add(link.target_node_id);
        }
      }
    }
    return set;
  }, [textLinks]);
  
  // Build link names map from fetched nodes
  // Uses getEffectiveIcon to compute icon from node or its classes
  const linkNames = useMemo(() => {
    const map = new Map<string, { name: string; isPage: boolean; isTag?: boolean; clickCount?: number; effectiveIcon?: string | null }>();
    if (allNodes && linkIds.length > 0) {
      for (const linkId of linkIds) {
        // linkId could be a node ID (number as string) - find the node
        const nodeId = parseInt(linkId, 10);
        const node = !isNaN(nodeId) 
          ? allNodes.find(n => n.id === nodeId)
          : allNodes.find(n => n.uuid === linkId || n.name === linkId);
        if (node) {
          // Compute effective icon using getEffectiveIcon - considers node's own icon and class icons
          const effectiveIcon = getEffectiveIcon(node, allClasses ?? []);
          map.set(linkId, {
            name: node.name || node.display_name || 'Untitled',
            isPage: node.is_page || node.parent_id === null,
            isTag: tagTargetIds.has(node.id),
            effectiveIcon: effectiveIcon,
          });
        }
      }
    }
    return map;
  }, [allNodes, allClasses, linkIds, tagTargetIds]);
  
  // Build type names map from fetched nodes
  const typeNames = useMemo(() => {
    const map = new Map<string, { name: string; icon?: string }>();
    if (allNodes && typeIds.length > 0) {
      for (const typeId of typeIds) {
        const nodeId = parseInt(typeId, 10);
        const node = !isNaN(nodeId) 
          ? allNodes.find(n => n.id === nodeId)
          : allNodes.find(n => n.uuid === typeId || n.name === typeId);
        if (node) {
          map.set(typeId, {
            name: node.name || 'Untitled',
            icon: node.icon || undefined,
          });
        }
      }
    }
    return map;
  }, [allNodes, typeIds]);
  
  // Sync external ref
  useEffect(() => {
    if (externalEditorRef && internalEditorRef.current) {
      (externalEditorRef as React.MutableRefObject<HTMLDivElement | null>).current = internalEditorRef.current;
    }
  }, [externalEditorRef]);
  
  // Track linkNames and typeNames size to detect when node data loads
  const linkNamesSize = linkNames.size;
  const typeNamesSize = typeNames.size;
  
  // Single effect to handle content rendering and cursor positioning
  useEffect(() => {
    if (!editorRef.current) return;
    
    // Skip if this is an internal change (user typing)
    if (isInternalChange.current) {
      isInternalChange.current = false;
      return;
    }
    
    const html = contentToHtml(content, linkNames, typeNames);
    const currentHtml = editorRef.current.innerHTML;
    
    // Check if we need to update the HTML
    const needsUpdate = html !== currentHtml && (html || '<br>') !== currentHtml;
    
    // Only save/restore cursor if the editor is focused
    const editorIsFocused = document.activeElement === editorRef.current;
    let savedPos: number | undefined;
    if (needsUpdate && initialCursorApplied.current && editorIsFocused) {
      savedPos = getCursorPosition(editorRef.current);
    }
    
    if (needsUpdate) {
      editorRef.current.innerHTML = html || '<br>';
      lastContentRef.current = content;
    }
    
    // Focus the editor only if initial cursor not yet applied (entering edit mode)
    if (!initialCursorApplied.current && document.activeElement !== editorRef.current) {
      editorRef.current.focus();
    }
    
    // Apply initial cursor position from pendingSelection (handled by useLayoutEffect)
    // or position at end if no pending selection and not yet initialized
    if (!initialCursorApplied.current && !pendingSelection) {
      // Position cursor at end if no pending selection specified
      const range = document.createRange();
      range.selectNodeContents(editorRef.current);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      initialCursorApplied.current = true;
    } else if (pendingSelection && !initialCursorApplied.current) {
      // pendingSelection will be handled by useLayoutEffect, mark as applied
      initialCursorApplied.current = true;
    }
    // If cursor was already applied, editor is focused, and HTML updated, restore saved position
    else if (needsUpdate && savedPos !== undefined && editorIsFocused) {
      setCursorPosition(editorRef.current, savedPos);
    }
  }, [content, linkNamesSize, typeNamesSize, linkNames, typeNames, pendingSelection]);
  
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

    // Arrow up/down navigation - check if cursor is on first/last line
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (!editorRef.current) return;
      
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      
      const range = selection.getRangeAt(0);
      
      // Capture caret X position for horizontal preservation
      const caretX = getCaretX();
      
      if (e.key === 'ArrowUp') {
        // Check if cursor is at the start or on the first line
        if (cursorPos === 0) {
          e.preventDefault();
          onNavigateUp?.(caretX);
          return;
        }
        
        // Check if cursor is on the first line visually
        const rangeRect = range.getBoundingClientRect();
        const editorRect = editorRef.current.getBoundingClientRect();
        
        // Calculate line height
        const computedStyle = getComputedStyle(editorRef.current);
        const lineHeight = parseFloat(computedStyle.lineHeight) || parseFloat(computedStyle.fontSize) * 1.5 || 24;
        
        // Use the top of the range rect, fallback to bottom if collapsed
        const cursorTop = rangeRect.height > 0 ? rangeRect.top : rangeRect.bottom;
        const relativeTop = cursorTop - editorRect.top;
        
        // If cursor is within 1.5 line heights from top, consider it on first line
        if (relativeTop < lineHeight * 1.5) {
          e.preventDefault();
          onNavigateUp?.(caretX);
          return;
        }
      } else if (e.key === 'ArrowDown') {
        // Check if we're at the end of content
        if (cursorPos === currentContent.length) {
          e.preventDefault();
          onNavigateDown?.(caretX);
          return;
        }
        
        // Check if cursor is on the last line visually
        const rangeRect = range.getBoundingClientRect();
        const editorRect = editorRef.current.getBoundingClientRect();
        
        // Calculate line height
        const computedStyle = getComputedStyle(editorRef.current);
        const lineHeight = parseFloat(computedStyle.lineHeight) || parseFloat(computedStyle.fontSize) * 1.5 || 24;
        
        // Use the bottom of the range rect, fallback to top if collapsed
        const cursorBottom = rangeRect.height > 0 ? rangeRect.bottom : rangeRect.top;
        const relativeBottom = editorRect.bottom - cursorBottom;
        
        // If cursor is within 1.5 line heights from bottom, consider it on last line
        if (relativeBottom < lineHeight * 1.5) {
          e.preventDefault();
          onNavigateDown?.(caretX);
          return;
        }
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
    } else if (trigger.type === 'tag' && keepInline) {
      // Inline tags use [[id]] format (same as links), but are marked as is_tag in the database
      const linkText = `[[${node.id}]]`;
      newContent = textBeforeTrigger + linkText + ' ' + textAfterCursor;
      
      // Callback will mark this link as a tag via API
      if (onAddTag) {
        onAddTag(node.id, keepInline, node.name || '');
      }
    } else if (trigger.type === 'type' && keepInline) {
      // Use {{classId}} format for inline classes
      const inlineText = `{{${node.id}}}`;
      newContent = textBeforeTrigger + inlineText + ' ' + textAfterCursor;
      
      if (onAddClass) {
        onAddClass(node.id, keepInline, node.name || '');
      }
    } else {
      // Non-inline: just remove trigger text and add to property
      newContent = textBeforeTrigger + textAfterCursor.trimStart();
      
      if (trigger.type === 'type' && onAddClass) {
        onAddClass(node.id, keepInline, node.name || '');
      } else if (trigger.type === 'tag' && onAddTag) {
        onAddTag(node.id, keepInline, node.name || '');
      }
    }
    
    // Calculate cursor position after the inserted content
    let cursorTargetPos: number;
    if (trigger.type === 'link') {
      const linkText = `[[${node.id}]]`;
      cursorTargetPos = textBeforeTrigger.length + linkText.length + 1; // +1 for space
    } else if (trigger.type === 'tag' && keepInline) {
      const linkText = `[[${node.id}]]`;
      cursorTargetPos = textBeforeTrigger.length + linkText.length + 1;
    } else if (trigger.type === 'type' && keepInline) {
      const inlineText = `{{${node.id}}}`;
      cursorTargetPos = textBeforeTrigger.length + inlineText.length + 1;
    } else {
      cursorTargetPos = textBeforeTrigger.length;
    }
    
    isInternalChange.current = true;
    lastContentRef.current = newContent;
    onChange(newContent);
    
    // Create updated linkNames map that includes the just-inserted node
    const updatedLinkNames = new Map(linkNames);
    if (trigger.type === 'link' || (trigger.type === 'tag' && keepInline)) {
      // Compute effective icon for the inserted node
      const nodeEffectiveIcon = getEffectiveIcon(node, allTypes ?? []);
      updatedLinkNames.set(String(node.id), {
        name: node.name || node.display_name || 'Untitled',
        isPage: node.is_page || node.parent_id === null,
        isTag: trigger.type === 'tag',  // Mark as tag for rendering
        effectiveIcon: nodeEffectiveIcon,
      });
    }
    
    // Create updated typeNames map that includes the just-inserted type
    const updatedTypeNames = new Map(typeNames);
    if (trigger.type === 'type' && keepInline) {
      updatedTypeNames.set(String(node.id), {
        name: node.name || 'Untitled',
        icon: node.icon || undefined,
      });
    }
    
    // Update HTML with the updated maps
    const html = contentToHtml(newContent, updatedLinkNames, updatedTypeNames);
    editorRef.current.innerHTML = html || '<br>';
    
    setTrigger(prev => ({ ...prev, isOpen: false }));
    
    // Refocus and position cursor after the inserted link
    setTimeout(() => {
      if (editorRef.current) {
        editorRef.current.focus();
        setCursorPosition(editorRef.current, cursorTargetPos);
      }
    }, 0);
  }, [trigger, onChange, onAddClass, onAddTag, onLinkPage, linkNames, typeNames, allClasses]);

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
      
      if (trigger.type === 'type' && onCreateClass) {
        onCreateClass(name, keepInline);
      } else if (trigger.type === 'tag' && onCreateTag) {
        onCreateTag(name, keepInline);
      }
    } else {
      newContent = textBeforeTrigger + textAfterCursor.trimStart();
      cursorTargetPos = textBeforeTrigger.length;
      
      if (trigger.type === 'type' && onCreateClass) {
        onCreateClass(name, keepInline);
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
      // New pages don't have an icon by default - effectiveIcon will be undefined
      updatedLinkNames.set(newPageId, {
        name: name,
        isPage: true,
        effectiveIcon: undefined, // New page - no icon yet
      });
    }
    
    // Update HTML with the updated map
    const html = contentToHtml(newContent, updatedLinkNames, typeNames);
    editorRef.current.innerHTML = html || '<br>';
    
    setTrigger(prev => ({ ...prev, isOpen: false }));
    
    // Refocus and position cursor after the inserted content
    setTimeout(() => {
      if (editorRef.current) {
        editorRef.current.focus();
        setCursorPosition(editorRef.current, cursorTargetPos);
      }
    }, 0);
  }, [trigger, onChange, onCreateClass, onCreateTag, onCreatePageLink, linkNames]);

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
      const html = contentToHtml(newContent, linkNames, typeNames);
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
    
    // For type command, insert @ and let checkTriggers handle it
    if (command === 'type') {
      const triggerText = '@';
      const newContent = textBeforeTrigger + triggerText + textAfterCursor;
      isInternalChange.current = true;
      lastContentRef.current = newContent;
      onChange(newContent);
      
      // Update HTML
      const html = contentToHtml(newContent, linkNames, typeNames);
      editorRef.current.innerHTML = html || '<br>';
      
      setSlashCommand(prev => ({ ...prev, isOpen: false }));
      
      // Position cursor after the trigger and let checkTriggers detect it
      setTimeout(() => {
        if (editorRef.current) {
          editorRef.current.focus();
          setCursorPosition(editorRef.current, slashCommand.triggerPosition + 1);
          // Trigger the check to show the suggestion popup
          checkTriggers(newContent);
        }
      }, 0);
      return;
    }
    
    // For tag command, insert # and let checkTriggers handle it
    if (command === 'tag') {
      const triggerText = '#';
      const newContent = textBeforeTrigger + triggerText + textAfterCursor;
      isInternalChange.current = true;
      lastContentRef.current = newContent;
      onChange(newContent);
      
      // Update HTML
      const html = contentToHtml(newContent, linkNames, typeNames);
      editorRef.current.innerHTML = html || '<br>';
      
      setSlashCommand(prev => ({ ...prev, isOpen: false }));
      
      // Position cursor after the trigger and let checkTriggers detect it
      setTimeout(() => {
        if (editorRef.current) {
          editorRef.current.focus();
          setCursorPosition(editorRef.current, slashCommand.triggerPosition + 1);
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
    const html = contentToHtml(newContent, linkNames, typeNames);
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
  }, [slashCommand.triggerPosition, onChange, onOpenComments, onAssetUpload, linkNames, typeNames, checkTriggers]);

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
