/**
 * TriggerPlugin — Detects trigger patterns (/, @, +, #) and shows popups.
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
  $getNodeByKey,
  $isTextNode,
  type LexicalEditor,
} from 'lexical';
import { $createInlineLinkNode } from '../nodes/InlineLinkNode';
import { TriggerSuggestionPopup } from './TriggerSuggestionPopup';
import { SlashCommandMenu } from './SlashCommandMenu';
import { findParentNodeBlock } from '../utils/selectionUtils';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { generateUUID } from '../../utils/uuid';
import { useInputContext } from '../../stores/inputContext';
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
  /** True when the popup was opened by the /template slash command */
  templateMode?: boolean;
  /** Class IDs to restrict results to (used in templateMode) */
  classFilters?: number[];
  /** Block server ID captured when templateMode was activated */
  templateBlockServerId?: number;
}

export interface TriggerPluginProps {
  /** Called when a link node is selected */
  onLinkSelect?: (linkId: string) => void;
  /** Called when a class should be added to block's class_ids (not inline) */
  onAddClass?: (blockServerId: number, classId: number) => void;
  /** Called when an action-type slash command is selected (table, query, code, image, audio, file, comment, property, url) */
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
  /** Called when a template is selected in templateMode (nodeId = template node server ID) */
  onTemplateInstantiate?: (templateNodeId: number, blockServerId: number | undefined) => void;
  /** Class IDs used to pre-filter the link popup when in templateMode */
  templateClassFilters?: number[];
}

export function TriggerPlugin({
  onLinkSelect: _onLinkSelect,
  onAddClass,
  onSlashCommand,
  onTemplateInstantiate,
  templateClassFilters,
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
  // Save the anchor text node key when the trigger opens so that handleSelect
  // can recover the correct insertion point even if the Lexical selection
  // drifted during an async operation (e.g. create-new-node mutation).
  const triggerAnchorKeyRef = useRef<string | null>(null);

  // ─── Insert embed sibling: create a new block after the current block ─

  const insertEmbedSibling = useCallback((nodeUuid: string) => {
    // Resolve the host block ID — captured when trigger opened, or from current selection
    const hostBlockId = embedHostBlockIdRef.current;
    if (!hostBlockId) return;

    const runtime = getNodeGraphRuntime();
    const hostNode = runtime.getNode(hostBlockId);
    if (!hostNode?.parentId) return;

    const newBlockId = generateUUID();
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
          if (trigger.embedMode || trigger.templateMode) {
            // Embed/template mode has no trigger char in the text — track everything before cursor
            const newQuery = textBefore;
            if (newQuery !== trigger.query) {
              setTrigger(prev => ({ ...prev, query: newQuery }));
            }
            return;
          }

          const triggerChar = trigger.type === 'link' ? '@' : trigger.type === 'type' ? '+' : '#';
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
          triggerAnchorKeyRef.current = anchorNode.getKey();
        } else if (trigger.isOpen) {
          setTrigger(prev => ({ ...prev, isOpen: false }));
          triggerAnchorKeyRef.current = null;
        }
      });
    });
  }, [editor, trigger.isOpen, trigger.embedMode, trigger.templateMode]);

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

  // ─── Track popup state in InputContext ─────────────────────

  useEffect(() => {
    if (trigger.isOpen) {
      useInputContext.getState().enterPopup();
      return () => useInputContext.getState().leavePopup();
    }
  }, [trigger.isOpen]);

  // ─── Handle selection ──────────────────────────────────────

  const handleSelect = useCallback((value: string, _metadata?: unknown) => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;

      if (trigger.type === 'link' || trigger.type === 'type' || trigger.type === 'tag') {
        const triggerChar =
          trigger.type === 'link' ? '@' : trigger.type === 'type' ? '+' : '#';

        const resolved = resolveTriggerAnchor(selection, trigger, triggerChar, triggerAnchorKeyRef);
        if (!resolved) return;

        const { anchorNode, triggerOffset } = resolved;
        const rawText = anchorNode.getTextContent();
        const startRaw = cleanToRawOffset(rawText, triggerOffset);
        const endClean = triggerOffset + 1 + trigger.query.length;
        const endRaw = cleanToRawOffset(rawText, endClean);

        selection.anchor.set(anchorNode.getKey(), startRaw, 'text');
        selection.focus.set(anchorNode.getKey(), endRaw, 'text');
        selection.removeText();

        if (anchorNode.getTextContent() === '') {
          anchorNode.setTextContent('\u200B');
        }

        const pill = $createInlineLinkNode(
          value,
          trigger.type === 'type' ? 'class' : 'node',
        );

        anchorNode.insertAfter(pill);

        const afterNode = $createTextNode('\u200B');
        pill.insertAfter(afterNode);
        afterNode.selectStart();

        return;
      }

      // Slash commands
      const anchorNode = selection.anchor.getNode();
      const rawText = anchorNode.getTextContent();
      const zwsBefore = (rawText.slice(0, selection.anchor.offset).match(/\u200B/g) || []).length;
      const cursorClean = selection.anchor.offset - zwsBefore;
      const text = rawText.replace(/\u200B/g, '');
      const beforeTrigger = text.slice(0, trigger.triggerOffset);
      const afterCursor = text.slice(cursorClean);

      if (value === 'embed') {
        const newText = (beforeTrigger + afterCursor.trimStart()) || '\u200B';
        (anchorNode as any).setTextContent(newText);
        const newOffset = beforeTrigger.length;
        selection.anchor.set(anchorNode.getKey(), newOffset, 'text');
        selection.focus.set(anchorNode.getKey(), newOffset, 'text');

        const embedBlockNode = findParentNodeBlock(anchorNode);
        if (embedBlockNode) {
          embedHostBlockIdRef.current = embedBlockNode.getBlockId();
        }

        setTimeout(() => {
          const coords = getCaretCoordinates(editor);
          setTrigger({
            isOpen: true,
            type: 'link',
            query: '',
            triggerOffset: 0,
            position: coords,
            embedMode: true,
          });
        }, 0);
        return;
      } else if (value === 'template') {
        const newText = (beforeTrigger + afterCursor.trimStart()) || '\u200B';
        (anchorNode as any).setTextContent(newText);
        const newOffset = beforeTrigger.length;
        selection.anchor.set(anchorNode.getKey(), newOffset, 'text');
        selection.focus.set(anchorNode.getKey(), newOffset, 'text');

        let templateBlockServerId: number | undefined;
        const tplBlockNode = findParentNodeBlock(anchorNode);
        if (tplBlockNode) {
          const runtime = getNodeGraphRuntime();
          const gn = runtime.getNode(tplBlockNode.getBlockId());
          templateBlockServerId = gn?.serverId;
        }

        setTimeout(() => {
          const coords = getCaretCoordinates(editor);
          setTrigger({
            isOpen: true,
            type: 'link',
            query: '',
            triggerOffset: 0,
            position: coords,
            templateMode: true,
            classFilters: templateClassFilters,
            templateBlockServerId,
          });
        }, 0);
        return;
      } else if (value === 'type') {
        const newText = beforeTrigger + '+' + afterCursor;
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
        const newText = (beforeTrigger + afterCursor.trimStart()) || '\u200B';
        (anchorNode as any).setTextContent(newText);
        const newOffset = beforeTrigger.length;
        selection.anchor.set(anchorNode.getKey(), newOffset, 'text');
        selection.focus.set(anchorNode.getKey(), newOffset, 'text');

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
          if ((value === 'link' || value === 'blocklink') && isPageBlock) {
            return;
          }
          setTimeout(() => onSlashCommand(value, blockServerId), 0);
        }
      }
    });

    setTrigger(prev => ({ ...prev, isOpen: false }));
  }, [editor, trigger, onSlashCommand, templateClassFilters]);

  const handleClose = useCallback(() => {
    setTrigger(prev => ({ ...prev, isOpen: false }));
  }, []);

  // ─── Render popup ──────────────────────────────────────────

  if (!trigger.isOpen) return null;

  if (trigger.type === 'link' || trigger.type === 'type' || trigger.type === 'tag') {
    const suggestionType: SuggestionType = trigger.type === 'type' ? 'class' : trigger.type;

    const handleSuggestionSelect = (node: Node, addInline: boolean) => {
      // For + type trigger: ALWAYS add to class_ids
      if (trigger.type === 'type' && onAddClass) {
        let blockServerId: number | undefined;
        
        if (addInline) {
          // Ctrl+Enter: Add to class_ids AND insert inline pill
          editor.read(() => {
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

            const triggerChar = '+';
            const resolved = resolveTriggerAnchor(selection, trigger, triggerChar, triggerAnchorKeyRef);
            if (!resolved) return;

            const { anchorNode, triggerOffset } = resolved;
            const rawText = anchorNode.getTextContent();
            const startRaw = cleanToRawOffset(rawText, triggerOffset);
            const endRaw = cleanToRawOffset(rawText, triggerOffset + 1 + trigger.query.length);

            selection.anchor.set(anchorNode.getKey(), startRaw, 'text');
            selection.focus.set(anchorNode.getKey(), endRaw, 'text');
            selection.removeText();

            if (anchorNode.getTextContent() === '') {
              anchorNode.setTextContent('\u200B');
            }

            const newOffset = startRaw;
            selection.anchor.set(anchorNode.getKey(), newOffset, 'text');
            selection.focus.set(anchorNode.getKey(), newOffset, 'text');

            const blockNode = findParentNodeBlock(anchorNode);
            if (blockNode) {
              const runtime = getNodeGraphRuntime();
              const graphNode = runtime.getNode(blockNode.getBlockId());
              blockServerId = graphNode?.serverId;
            }
          });

          if (blockServerId != null) {
            onAddClass(blockServerId, node.id);
          }
          setTrigger(prev => ({ ...prev, isOpen: false }));
        }
      } else if (trigger.type === 'type') {
        // + class trigger but onAddClass not provided — remove trigger text without inserting inline
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const triggerChar = '+';
          const resolved = resolveTriggerAnchor(selection, trigger, triggerChar, triggerAnchorKeyRef);
          if (!resolved) return;
          const { anchorNode, triggerOffset } = resolved;
          const rawText = anchorNode.getTextContent();
          const startRaw = cleanToRawOffset(rawText, triggerOffset);
          const endRaw = cleanToRawOffset(rawText, triggerOffset + 1 + trigger.query.length);
          selection.anchor.set(anchorNode.getKey(), startRaw, 'text');
          selection.focus.set(anchorNode.getKey(), endRaw, 'text');
          selection.removeText();
          if (anchorNode.getTextContent() === '') {
            anchorNode.setTextContent('\u200B');
          }
          const newOffset = startRaw;
          selection.anchor.set(anchorNode.getKey(), newOffset, 'text');
          selection.focus.set(anchorNode.getKey(), newOffset, 'text');
        });
        setTrigger(prev => ({ ...prev, isOpen: false }));
      } else {
        // For # tag and @ link triggers
        if (trigger.templateMode) {
          // Template mode: remove the search text typed during template search,
          // then instantiate the selected template
          editor.update(() => {
            const sel = $getSelection();
            if (!$isRangeSelection(sel)) return;
            const anchor = sel.anchor.getNode();
            const rawText = anchor.getTextContent();
            const text = rawText.replace(/\u200B/g, '');
            const zwsBefore = (rawText.slice(0, sel.anchor.offset).match(/\u200B/g) || []).length;
            const cursorClean = sel.anchor.offset - zwsBefore;
            // triggerOffset is 0 in template mode; remove everything from 0 to cursor
            const beforeTrigger = text.slice(0, trigger.triggerOffset);
            const afterCursor = text.slice(cursorClean);
            const newText = (beforeTrigger + afterCursor) || '\u200B';
            (anchor as any).setTextContent(newText);
            const newOffset = beforeTrigger.length;
            sel.anchor.set(anchor.getKey(), newOffset, 'text');
            sel.focus.set(anchor.getKey(), newOffset, 'text');
          });
          if (onTemplateInstantiate) {
            onTemplateInstantiate(node.id, trigger.templateBlockServerId);
          }
          setTrigger(prev => ({ ...prev, isOpen: false }));
        } else if (trigger.embedMode) {
          // Embed mode (opened by /embed slash command): create sibling embed block
          insertEmbedSibling(node.uuid);
          setTrigger(prev => ({ ...prev, isOpen: false }));
        } else {
          // Standard: always insert as inline pill
          handleSelect(node.uuid, { node, type: suggestionType });
        }
      }
    };

    // Alt+Enter: insert as embed sibling (for regular @ link trigger)
    const handleSelectEmbed = (node: Node) => {
      if (!trigger.embedMode) {
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const triggerChar = '@';
          const resolved = resolveTriggerAnchor(selection, trigger, triggerChar, triggerAnchorKeyRef);
          if (!resolved) return;
          const { anchorNode, triggerOffset } = resolved;
          const rawText = anchorNode.getTextContent();
          const startRaw = cleanToRawOffset(rawText, triggerOffset);
          const zwsBefore = (rawText.slice(0, selection.anchor.offset).match(/\u200B/g) || []).length;
          const cursorClean = selection.anchor.offset - zwsBefore;
          const endRaw = cleanToRawOffset(rawText, cursorClean);

          selection.anchor.set(anchorNode.getKey(), startRaw, 'text');
          selection.focus.set(anchorNode.getKey(), endRaw, 'text');
          selection.removeText();

          const remaining = anchorNode.getTextContent().slice(startRaw).trimStart();
          const before = anchorNode.getTextContent().slice(0, startRaw);
          anchorNode.setTextContent((before + remaining) || '\u200B');
          const newOffset = before.length;
          selection.anchor.set(anchorNode.getKey(), newOffset, 'text');
          selection.focus.set(anchorNode.getKey(), newOffset, 'text');
        });
      }
      insertEmbedSibling(node.uuid);
    };

    const handleSelectDatePage = (pageId: string, _pageName: string) => {
      handleSelect(pageId, { type: 'date' });
    };

    // Parse +class syntax from link trigger query
    const parsedLinkQuery = trigger.type === 'link' ? parseLinkQueryWithClass(trigger.query) : null;
    const linkQuery = parsedLinkQuery?.linkQuery ?? trigger.query;
    const isTypingClass = parsedLinkQuery?.isTypingClass ?? false;
    const classQuery = parsedLinkQuery?.classQuery ?? '';

    const handleClassSelect = (classNode: Node) => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const triggerChar = '@';
        const resolved = resolveTriggerAnchor(selection, trigger, triggerChar, triggerAnchorKeyRef);
        if (!resolved) return;
        const { anchorNode, triggerOffset } = resolved;
        const rawText = anchorNode.getTextContent();
        const text = rawText.replace(/\u200B/g, '');
        const afterTriggerChar = text.slice(triggerOffset + 1);
        const plusIdx = afterTriggerChar.indexOf('+');
        if (plusIdx === -1) return;

        const startRaw = cleanToRawOffset(rawText, triggerOffset + 1 + plusIdx);
        const zwsBefore = (rawText.slice(0, selection.anchor.offset).match(/\u200B/g) || []).length;
        const cursorClean = selection.anchor.offset - zwsBefore;
        const endRaw = cleanToRawOffset(rawText, cursorClean);

        selection.anchor.set(anchorNode.getKey(), startRaw, 'text');
        selection.focus.set(anchorNode.getKey(), endRaw, 'text');
        selection.removeText();

        if (anchorNode.getTextContent() === '') {
          anchorNode.setTextContent('\u200B');
        }

        const newOffset = startRaw;
        selection.anchor.set(anchorNode.getKey(), newOffset, 'text');
        selection.focus.set(anchorNode.getKey(), newOffset, 'text');
      });
      setTrigger(prev => ({
        ...prev,
        classFilters: [...(prev.classFilters ?? []).filter(id => id !== classNode.id), classNode.id],
      }));
    };

    return (
      <TriggerSuggestionPopup
        suggestionType={suggestionType}
        triggerType={trigger.type}
        query={linkQuery}
        position={trigger.position}
        onSelect={handleSuggestionSelect}
        onClose={handleClose}
        onSelectDatePage={trigger.type === 'link' && !trigger.templateMode ? handleSelectDatePage : undefined}
        onSelectEmbed={trigger.type === 'link' && !trigger.templateMode && !trigger.embedMode ? handleSelectEmbed : undefined}
        classFilters={trigger.classFilters}
        headerText={trigger.templateMode ? 'Insert template' : undefined}
        footerHintText={trigger.templateMode ? 'insert template' : undefined}
        hideCreate={trigger.templateMode}
        isTypingClass={trigger.type === 'link' ? isTypingClass : undefined}
        classQuery={trigger.type === 'link' ? classQuery : undefined}
        onClassSelect={trigger.type === 'link' ? handleClassSelect : undefined}
        lexicalEditor={editor}
      />
    );
  }

  return (
    <SlashCommandMenu
      query={trigger.query}
      position={trigger.position}
      onSelect={handleSelect}
      onClose={handleClose}
      lexicalEditor={editor}
    />
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function cleanToRawOffset(rawText: string, cleanIdx: number): number {
  let rawIdx = 0;
  let cleanCount = 0;
  for (const char of rawText) {
    if (char !== '\u200B') {
      if (cleanCount === cleanIdx) return rawIdx;
      cleanCount++;
    }
    rawIdx++;
  }
  return rawIdx;
}

function resolveTriggerAnchor(
  selection: ReturnType<typeof $getSelection>,
  trigger: TriggerState,
  triggerChar: string,
  triggerAnchorKeyRef: { current: string | null },
): { anchorNode: import('lexical').TextNode; triggerOffset: number } | null {
  if (!$isRangeSelection(selection)) return null;

  let anchorNode = selection.anchor.getNode();

  const isValidAnchor = (node: ReturnType<typeof $getNodeByKey>): node is import('lexical').TextNode => {
    if (!node || !$isTextNode(node)) return false;
    const t = node.getTextContent().replace(/\u200B/g, '');
    return trigger.triggerOffset < t.length && t[trigger.triggerOffset] === triggerChar;
  };

  if (isValidAnchor(anchorNode)) {
    return { anchorNode, triggerOffset: trigger.triggerOffset };
  }

  const saved = triggerAnchorKeyRef.current ? $getNodeByKey(triggerAnchorKeyRef.current) : null;
  if (isValidAnchor(saved)) {
    return { anchorNode: saved!, triggerOffset: trigger.triggerOffset };
  }

  const blockNode = findParentNodeBlock(anchorNode);
  if (!blockNode) return null;

  let foundNode: import('lexical').TextNode | null = null;
  let foundOffset = -1;
  blockNode.getChildren().forEach(child => {
    if ($isTextNode(child) && foundNode === null) {
      const t = child.getTextContent().replace(/\u200B/g, '');
      const pattern = triggerChar + trigger.query;
      const idx = t.lastIndexOf(pattern);
      if (idx !== -1) {
        foundNode = child;
        foundOffset = idx;
      }
    }
  });

  if (foundNode) {
    return { anchorNode: foundNode, triggerOffset: foundOffset };
  }

  return null;
}

interface TriggerMatch {
  type: TriggerType;
  query: string;
  triggerStart: number;
}

function parseLinkQueryWithClass(query: string): { linkQuery: string; isTypingClass: boolean; classQuery: string } {
  const classMatch = query.match(/^(.*?)\+(\S*)$/);
  if (classMatch) {
    return { linkQuery: classMatch[1], isTypingClass: true, classQuery: classMatch[2] };
  }
  return { linkQuery: query, isTypingClass: false, classQuery: '' };
}

function detectTriggerPattern(text: string): TriggerMatch | null {
  // @ link trigger (not preceded by word char)
  const linkMatch = text.match(/(?:^|[^a-zA-Z0-9])@([^@\s]*)$/);
  if (linkMatch) {
    return {
      type: 'link',
      query: linkMatch[1],
      triggerStart: text.length - linkMatch[1].length - 1,
    };
  }

  // + type trigger (not preceded by word char)
  const typeMatch = text.match(/(?:^|[^a-zA-Z0-9])\+([^+\s]*)$/);
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

  const nativeSelection = window.getSelection();
  if (!nativeSelection || nativeSelection.rangeCount === 0) return { top: 0, left: 0 };

  const range = nativeSelection.getRangeAt(0);
  // Validate that the native selection belongs to our editor — if focus
  // has moved to a modal or other element, ignore it.
  if (!rootEl.contains(range.startContainer)) return { top: 0, left: 0 };

  const cloned = range.cloneRange();
  cloned.collapse(true);

  const rect = cloned.getBoundingClientRect();
  return {
    top: rect.bottom + window.scrollY,
    left: rect.left + window.scrollX,
  };
}
