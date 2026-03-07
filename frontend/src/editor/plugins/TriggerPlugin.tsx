/**
 * TriggerPlugin — Detects trigger patterns (/, +, @, #) and shows popups.
 *
 * Monitors text input for trigger characters and displays the appropriate
 * popup menu for inserting links, types, tags, or slash commands.
 */

import { useEffect, useState, useCallback, useRef, type JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_NORMAL,
  KEY_ESCAPE_COMMAND,
  $getSelection,
  $isRangeSelection,
  $createTextNode,
  type LexicalEditor,
} from 'lexical';
import { $createInlineLinkNode } from '../nodes/InlineLinkNode';
import { TriggerSuggestionPopup } from './TriggerSuggestionPopup';
import { SlashCommandMenu } from './SlashCommandMenu';
import { findParentNodeBlock } from '../utils/selectionUtils';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import type { SuggestionType } from '../../components/nodes/SuggestionPopup';
import type { Node } from '../../types/api';

// ─── Types ────────────────────────────────────────────────────────

export type TriggerType = 'link' | 'type' | 'tag' | 'slash';

interface TriggerState {
  isOpen: boolean;
  type: TriggerType;
  query: string;
  triggerOffset: number;
  position: { top: number; left: number };
  /** True when the + popup was opened by the /embed slash command or Alt+Enter */
  embedMode?: boolean;
}

export interface TriggerPluginProps {
  /** Called when a link node is selected */
  onLinkSelect?: (linkId: string) => void;
  /** Called when a class should be added to block's class_ids (not inline) */
  onAddClass?: (blockServerId: number, classId: number) => void;
  /** Called when an action-type slash command is selected (table, query, code, image, audio, file, comment, property, url) */
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
}

export function TriggerPlugin({
  onLinkSelect,
  onAddClass,
  onSlashCommand,
}: TriggerPluginProps): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [trigger, setTrigger] = useState<TriggerState>({
    isOpen: false,
    type: 'slash',
    query: '',
    triggerOffset: 0,
    position: { top: 0, left: 0 },
  });
  const lastTextRef = useRef('');
  // Capture the host block ID when an embed trigger opens (so we can create sibling)
  const embedHostBlockIdRef = useRef<string | null>(null);

  // ─── Insert embed sibling: create a new block after the current block ─

  const insertEmbedSibling = useCallback((nodeUuid: string) => {
    // Resolve the host block ID — captured when trigger opened, or from current selection
    const hostBlockId = embedHostBlockIdRef.current;
    if (!hostBlockId) return;

    const runtime = getNodeGraphRuntime();
    const hostNode = runtime.getNode(hostBlockId);
    if (!hostNode?.parentId) return;

    const newBlockId = crypto.randomUUID();
    runtime.requestFocus(newBlockId);
    runtime.applyIntent({
      type: 'create_block',
      parentId: hostNode.parentId,
      afterBlockId: hostBlockId,
      blockId: newBlockId,
      contentAST: [{
        type: 'paragraph',
        children: [{ type: 'node_link', link_id: nodeUuid, ref_type: 'embed' }],
      }],
    });
    runtime.flushEvents();
    embedHostBlockIdRef.current = null;
    setTrigger(prev => ({ ...prev, isOpen: false }));
  }, []);

  // ─── Detect triggers on text change ────────────────────────

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, tags }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          if (trigger.isOpen) setTrigger(prev => ({ ...prev, isOpen: false }));
          return;
        }

        const anchorNode = selection.anchor.getNode();
        const text = anchorNode.getTextContent();
        const offset = selection.anchor.offset;

        // Only detect new triggers when text was actually typed, not on
        // pure cursor movements (clicks, arrow keys).  We allow continued
        // detection while a trigger is already open so the query updates
        // as the user keeps typing.
        const textChanged = text !== lastTextRef.current;
        lastTextRef.current = text;

        // If nothing was typed and no trigger is open, skip detection.
        // Also skip history-undo/redo replays — they aren't fresh typing.
        if (!textChanged && !trigger.isOpen) return;
        if (tags.has('historic')) {
          if (trigger.isOpen) setTrigger(prev => ({ ...prev, isOpen: false }));
          return;
        }

        // Strip zero-width spaces before trigger detection —
        // empty blocks use ZWS for cursor placement and the transform
        // cleans it up, but there can be a single tick where the
        // raw text still contains it.
        const cleanText = text.replace(/\u200B/g, '');
        const zwsBeforeCursor = (text.slice(0, offset).match(/\u200B/g) || []).length;
        const cleanOffset = offset - zwsBeforeCursor;

        // Look backwards from cursor for trigger patterns
        const textBefore = cleanText.slice(0, cleanOffset);

        // If a link/type/tag trigger is already open, use stateful tracking instead of
        // re-running pattern detection. This keeps the popup alive when the user types
        // spaces or other characters — it only closes when the trigger char itself is
        // deleted or the cursor moves before it.
        if (trigger.isOpen && (trigger.type === 'link' || trigger.type === 'type' || trigger.type === 'tag')) {
          if (trigger.embedMode) {
            // Embed mode has no trigger char in the text — track everything before cursor
            const newQuery = textBefore;
            if (newQuery !== trigger.query) {
              setTrigger(prev => ({ ...prev, query: newQuery }));
            }
            return;
          }

          const triggerChar = trigger.type === 'link' ? '+' : trigger.type === 'type' ? '@' : '#';
          if (cleanOffset <= trigger.triggerOffset || cleanText[trigger.triggerOffset] !== triggerChar) {
            // Trigger char was deleted or cursor moved before it — close popup
            setTrigger(prev => ({ ...prev, isOpen: false }));
            return;
          }

          // Query = everything typed after the trigger character up to the cursor
          const newQuery = textBefore.slice(trigger.triggerOffset + 1);
          if (newQuery !== trigger.query) {
            setTrigger(prev => ({ ...prev, query: newQuery }));
          }
          return;
        }

        const match = detectTriggerPattern(textBefore);

        if (match) {
          const coords = getCaretCoordinates(editor);
          // For link triggers, capture the current block ID for Alt+Enter embed
          // and suppress the popup if the current block is a page.
          if (match.type === 'link' && !trigger.embedMode) {
            const blockNode = findParentNodeBlock(anchorNode);
            if (blockNode) {
              const runtime = getNodeGraphRuntime();
              const graphNode = runtime.getNode(blockNode.getBlockId());
              if (graphNode?.isPage) {
                // Node links are not allowed in page-typed blocks
                if (trigger.isOpen) setTrigger(prev => ({ ...prev, isOpen: false }));
                return;
              }
              embedHostBlockIdRef.current = blockNode.getBlockId();
            }
          }
          setTrigger({
            isOpen: true,
            type: match.type,
            query: match.query,
            triggerOffset: match.triggerStart,
            position: coords,
          });
        } else if (trigger.isOpen) {
          setTrigger(prev => ({ ...prev, isOpen: false }));
        }
      });
    });
  }, [editor, trigger.isOpen, trigger.embedMode]);

  // ─── Escape closes trigger ─────────────────────────────────

  useEffect(() => {
    if (!trigger.isOpen) return;

    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        setTrigger(prev => ({ ...prev, isOpen: false }));
        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor, trigger.isOpen]);

  // ─── Handle selection ──────────────────────────────────────

  const handleSelect = useCallback((value: string, _metadata?: any) => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;

      // Remove trigger text and insert the selected item
      const anchorNode = selection.anchor.getNode();
      const rawText = anchorNode.getTextContent();
      // Strip ZWS so that trigger offsets (computed from clean text) align
      const text = rawText.replace(/\u200B/g, '');
      const zwsBefore = (rawText.slice(0, selection.anchor.offset).match(/\u200B/g) || []).length;
      const cursorClean = selection.anchor.offset - zwsBefore;

      // Remove trigger text
      const beforeTrigger = text.slice(0, trigger.triggerOffset);
      const afterCursor = text.slice(cursorClean);

      if (trigger.type === 'link' || trigger.type === 'type' || trigger.type === 'tag') {
        // Replace with a Pill
        // Use zero-width space if empty to prevent Lexical from removing the text node
        (anchorNode as any).setTextContent(beforeTrigger || '\u200B');

        const pill = $createInlineLinkNode(
          value,
          trigger.type === 'type' ? 'class' : 'node',
        );

        anchorNode.insertAfter(pill);

        // Always add a text node after pill for proper cursor navigation
        // Use zero-width space if empty to prevent Lexical from removing the text node
        const afterNode = $createTextNode(afterCursor || '\u200B');
        pill.insertAfter(afterNode);
        afterNode.selectStart();

        // Don't call onLinkSelect here - that's for clicking existing pills,
        // not for inserting new ones. Calling it would trigger navigation.
        // onLinkSelect?.(value);
      } else if (trigger.type === 'slash') {
        // For type/tag slash commands, re-trigger those popups
        if (value === 'embed') {
          // Remove trigger text and open the + popup in embed mode
          const newText = (beforeTrigger + afterCursor.trimStart()) || '\u200B';
          (anchorNode as any).setTextContent(newText);
          const newOffset = beforeTrigger.length;
          selection.anchor.set(anchorNode.getKey(), newOffset, 'text');
          selection.focus.set(anchorNode.getKey(), newOffset, 'text');

          // Capture the host block ID before re-opening
          const embedBlockNode = findParentNodeBlock(anchorNode);
          if (embedBlockNode) {
            embedHostBlockIdRef.current = embedBlockNode.getBlockId();
          }

          // Open + trigger in embed mode after the update
          const coords = getCaretCoordinates(editor);
          setTimeout(() => {
            setTrigger({
              isOpen: true,
              type: 'link',
              query: '',
              triggerOffset: 0,
              position: coords,
              embedMode: true,
            });
          }, 0);
          // Don't close trigger normally — we're reopening it
          return;        } else if (value === 'type') {
          const newText = beforeTrigger + '@' + afterCursor;
          (anchorNode as any).setTextContent(newText || '\u200B');
          const newOffset = beforeTrigger.length + 1;
          selection.anchor.set(anchorNode.getKey(), newOffset, 'text');
          selection.focus.set(anchorNode.getKey(), newOffset, 'text');
        } else if (value === 'tag') {
          const newText = beforeTrigger + '#' + afterCursor;
          (anchorNode as any).setTextContent(newText || '\u200B');
          const newOffset = beforeTrigger.length + 1;
          selection.anchor.set(anchorNode.getKey(), newOffset, 'text');
          selection.focus.set(anchorNode.getKey(), newOffset, 'text');
        } else {
          // Action-type slash commands: remove trigger text and fire callback
          const newText = (beforeTrigger + afterCursor.trimStart()) || '\u200B';
          (anchorNode as any).setTextContent(newText);
          const newOffset = beforeTrigger.length;
          selection.anchor.set(anchorNode.getKey(), newOffset, 'text');
          selection.focus.set(anchorNode.getKey(), newOffset, 'text');

          // Resolve the parent block's server ID and page status
          if (onSlashCommand) {
            const blockNode = findParentNodeBlock(anchorNode);
            let blockServerId: number | undefined;
            let isPageBlock = false;
            if (blockNode) {
              const runtime = getNodeGraphRuntime();
              const graphNode = runtime.getNode(blockNode.getBlockId());
              blockServerId = graphNode?.serverId;
              isPageBlock = graphNode?.isPage ?? false;
            }
            // Node links are not allowed in page-typed blocks
            if ((value === 'link' || value === 'blocklink') && isPageBlock) {
              return;
            }
            // Defer callback to after the editor update completes
            setTimeout(() => onSlashCommand(value, blockServerId), 0);
          }
        }
      }
    });

    setTrigger(prev => ({ ...prev, isOpen: false }));
  }, [editor, trigger, onSlashCommand]);

  const handleClose = useCallback(() => {
    setTrigger(prev => ({ ...prev, isOpen: false }));
  }, []);

  // ─── Render popup ──────────────────────────────────────────

  if (!trigger.isOpen) return null;

  if (trigger.type === 'link' || trigger.type === 'type' || trigger.type === 'tag') {
    const suggestionType: SuggestionType = trigger.type === 'type' ? 'class' : trigger.type;

    const handleSuggestionSelect = (node: Node, addInline: boolean) => {
      // For @ type trigger: ALWAYS add to class_ids
      if (trigger.type === 'type' && onAddClass) {
        let blockServerId: number | undefined;
        
        if (addInline) {
          // Ctrl+Enter: Add to class_ids AND insert inline pill
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;

            const anchorNode = selection.anchor.getNode();
            const blockNode = findParentNodeBlock(anchorNode);
            if (blockNode) {
              const runtime = getNodeGraphRuntime();
              const graphNode = runtime.getNode(blockNode.getBlockId());
              blockServerId = graphNode?.serverId;
            }
          });

          // Add class to block's class_ids
          if (blockServerId != null) {
            onAddClass(blockServerId, node.id);
          }
          
          // Also insert as inline pill
          handleSelect(node.uuid, { node, type: suggestionType });
        } else {
          // Plain Enter: Add to class_ids only (no inline pill)
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;

            const anchorNode = selection.anchor.getNode();
            const rawText = anchorNode.getTextContent();
            const text = rawText.replace(/\u200B/g, '');
            const zwsBefore = (rawText.slice(0, selection.anchor.offset).match(/\u200B/g) || []).length;
            const cursorClean = selection.anchor.offset - zwsBefore;

            // Remove trigger text
            const beforeTrigger = text.slice(0, trigger.triggerOffset);
            const afterCursor = text.slice(cursorClean);
            
            // Just set the text without the trigger, no Pill
            const newText = beforeTrigger + afterCursor;
            (anchorNode as any).setTextContent(newText || '\u200B');
            
            // Position cursor where trigger was
            const newOffset = beforeTrigger.length;
            selection.anchor.set(anchorNode.getKey(), newOffset, 'text');
            selection.focus.set(anchorNode.getKey(), newOffset, 'text');

            // Resolve the parent block's server ID for the onAddClass call
            const blockNode = findParentNodeBlock(anchorNode);
            if (blockNode) {
              const runtime = getNodeGraphRuntime();
              const graphNode = runtime.getNode(blockNode.getBlockId());
              blockServerId = graphNode?.serverId;
            }
          });

          // Add class to block's class_ids
          if (blockServerId != null) {
            onAddClass(blockServerId, node.id);
          }
          setTrigger(prev => ({ ...prev, isOpen: false }));
        }
      } else {
        // For # tag and + link triggers
        if (trigger.embedMode) {
          // Embed mode (opened by /embed slash command): create sibling embed block
          insertEmbedSibling(node.uuid);
          setTrigger(prev => ({ ...prev, isOpen: false }));
        } else {
          // Standard: always insert as inline pill
          handleSelect(node.uuid, { node, type: suggestionType });
        }
      }
    };

    // Alt+Enter: insert as embed sibling (for regular + link trigger)
    const handleSelectEmbed = (node: Node) => {
      // Remove the + trigger text first (doesn't apply in embedMode — already cleaned)
      if (!trigger.embedMode) {
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const anchorNode = selection.anchor.getNode();
          const rawText = anchorNode.getTextContent();
          const text = rawText.replace(/\u200B/g, '');
          const zwsBefore = (rawText.slice(0, selection.anchor.offset).match(/\u200B/g) || []).length;
          const cursorClean = selection.anchor.offset - zwsBefore;
          const beforeTrigger = text.slice(0, trigger.triggerOffset);
          const afterCursor = text.slice(cursorClean);
          const newText = (beforeTrigger + afterCursor.trimStart()) || '\u200B';
          (anchorNode as any).setTextContent(newText);
        });
      }
      insertEmbedSibling(node.uuid);
    };

    const handleSelectDatePage = (pageId: string, _pageName: string) => {
      handleSelect(pageId, { type: 'date' });
    };

    return (
      <TriggerSuggestionPopup
        suggestionType={suggestionType}
        triggerType={trigger.type}
        query={trigger.query}
        position={trigger.position}
        onSelect={handleSuggestionSelect}
        onClose={handleClose}
        onSelectDatePage={trigger.type === 'link' ? handleSelectDatePage : undefined}
        onSelectEmbed={trigger.type === 'link' ? handleSelectEmbed : undefined}
      />
    );
  }

  return (
    <SlashCommandMenu
      query={trigger.query}
      position={trigger.position}
      onSelect={handleSelect}
      onClose={handleClose}
    />
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

interface TriggerMatch {
  type: TriggerType;
  query: string;
  triggerStart: number;
}

function detectTriggerPattern(text: string): TriggerMatch | null {
  // + link trigger (not preceded by word char)
  const linkMatch = text.match(/(?:^|[^a-zA-Z0-9])\+([^+\s]*)$/);
  if (linkMatch) {
    return {
      type: 'link',
      query: linkMatch[1],
      triggerStart: text.length - linkMatch[1].length - 1,
    };
  }

  // @ type trigger (not preceded by word char)
  const typeMatch = text.match(/(?:^|[^a-zA-Z0-9])@([^@\s]*)$/);
  if (typeMatch) {
    return {
      type: 'type',
      query: typeMatch[1],
      triggerStart: text.length - typeMatch[1].length - 1,
    };
  }

  // # tag trigger (not preceded by word char)
  const tagMatch = text.match(/(?:^|[^a-zA-Z0-9])#([^#\s]*)$/);
  if (tagMatch) {
    return {
      type: 'tag',
      query: tagMatch[1],
      triggerStart: text.length - tagMatch[1].length - 1,
    };
  }

  // / slash command (at start of text or after whitespace)
  const slashMatch = text.match(/(?:^|\s)\/([^\s]*)$/);
  if (slashMatch) {
    return {
      type: 'slash',
      query: slashMatch[1],
      triggerStart: text.length - slashMatch[1].length - 1,
    };
  }

  return null;
}

function getCaretCoordinates(editor: LexicalEditor): { top: number; left: number } {
  const rootEl = editor.getRootElement();
  if (!rootEl) return { top: 0, left: 0 };

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return { top: 0, left: 0 };

  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);

  const rect = range.getBoundingClientRect();
  return {
    top: rect.bottom + window.scrollY,
    left: rect.left + window.scrollX,
  };
}
