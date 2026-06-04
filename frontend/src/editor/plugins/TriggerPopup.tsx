/**
 * TriggerPopup — Unified popup for all editor triggers (+, @, #, /).
 *
 * Features:
 * - Rendered via React portal to document.body (escapes editor DOM tree)
 * - Own search input field (no inline text pollution)
 * - Shift+Enter for alternative action
 * - Focus management (editor → popup → editor)
 * - Position adjustment to stay in viewport
 */

import { useState, useRef, useEffect, useMemo, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Node } from '@/types';
import { useNodeSearch, type NodeSearchItem } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useClasses } from '@/hooks/useNodeQueries';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import { NodeResultItem } from '@/components/nodes/NodeResultItem';
import { useCreateNode } from '@/hooks/useNodes';
import { usePageClass, useClassClass } from '@/hooks/usePageClass';
import { Spinner } from '@/components/core/Spinner';
import { AddIcon } from '@/components/core/icons';
import './TriggerPopup.css';

export type TriggerPopupType = 'class' | 'link' | 'tag' | 'slash';

interface SlashCommand {
  id: string;
  label: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'link', label: 'Insert Page Link', description: 'Link to a page' },
  { id: 'blocklink', label: 'Insert Block Link', description: 'Link to a specific block' },
  { id: 'embed', label: 'Embed Node', description: 'Embed the full content of a node' },
  { id: 'url', label: 'Add URL', description: 'Add a URL link to external website' },
  { id: 'type', label: 'Add Class', description: 'Add a class to this block' },
  { id: 'tag', label: 'Add Tag', description: 'Add a tag to this block' },
  { id: 'property', label: 'Add property', description: 'Add a property to this block' },
  { id: 'query', label: 'Query', description: 'Assign query class to this block' },
  { id: 'table', label: 'Table', description: 'Convert block to table' },
  { id: 'code', label: 'Code Block', description: 'Convert block to code block' },
  { id: 'task', label: 'Task', description: 'Convert block to task' },
  { id: 'comment', label: 'Add comment', description: 'Add a comment to this block' },
  { id: 'image', label: 'Insert image', description: 'Upload an image' },
  { id: 'audio', label: 'Insert audio', description: 'Upload an audio file' },
  { id: 'file', label: 'Insert file', description: 'Upload any supported file' },
  { id: 'template', label: 'Add template', description: 'Insert content from a template' },
  { id: 'move', label: 'Move to page', description: 'Move this block under a different page' },
];

export interface TriggerPopupProps {
  type: TriggerPopupType;
  position: { top: number; left: number; caretTop: number };
  onSelectNode?: (node: Node, mode: 'default' | 'alternative') => void;
  onSelectCommand?: (commandId: string) => void;
  onClose: () => void;
  /** Called when user presses Backspace/Delete to remove the trigger placeholder */
  onDeletePlaceholder?: () => void;
}

export function TriggerPopup({
  type,
  position,
  onSelectNode,
  onSelectCommand,
  onClose,
  onDeletePlaceholder,
}: TriggerPopupProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [placement, setPlacement] = useState<'below' | 'above'>('below');
  const [popupPos, setPopupPos] = useState<{ top: number; left: number }>({ top: position.top, left: position.left });
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isNodeTrigger = type !== 'slash';

  // Node search
  const searchMode = type === 'class' ? 'classes' : type === 'tag' ? 'tags' : 'all';
  const { pageResults, blockResults, isLoading, showCreateOption } = useNodeSearch(
    query,
    { mode: searchMode, maxResults: 10 }
  );

  const nodeItems: NodeSearchItem[] = useMemo(
    () => [...pageResults, ...blockResults],
    [pageResults, blockResults]
  );

  // Slash command usage tracking (localStorage)
  const commandUsage = useMemo(() => {
    try {
      const raw = localStorage.getItem('notees_slash_cmd_usage');
      return raw ? (JSON.parse(raw) as Record<string, number>) : {};
    } catch {
      return {} as Record<string, number>;
    }
  }, []);

  const bumpCommandUsage = useCallback((commandId: string) => {
    try {
      const next = { ...commandUsage, [commandId]: (commandUsage[commandId] || 0) + 1 };
      localStorage.setItem('notees_slash_cmd_usage', JSON.stringify(next));
    } catch {
      // ignore quota errors
    }
  }, [commandUsage]);

  // Slash command filtering + frequency sorting
  const commandItems: SlashCommand[] = useMemo(() => {
    if (type !== 'slash') return [];
    const lower = query.toLowerCase();
    const scored = SLASH_COMMANDS.map((c) => {
      const labelMatch = c.label.toLowerCase().includes(lower);
      const descMatch = c.description.toLowerCase().includes(lower);
      const textScore = (labelMatch ? 2 : 0) + (descMatch ? 1 : 0);
      return { cmd: c, textScore, freq: commandUsage[c.id] || 0 };
    }).filter((s) => s.textScore > 0 || !query);
    scored.sort((a, b) => {
      if (b.textScore !== a.textScore) return b.textScore - a.textScore;
      return b.freq - a.freq;
    });
    return scored.map((s) => s.cmd);
  }, [type, query, commandUsage]);

  const items = isNodeTrigger ? nodeItems : commandItems;
  const itemCount = items.length + (isNodeTrigger && showCreateOption && query.trim() ? 1 : 0);

  // Clamp selected index to valid range whenever itemCount changes
  const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(0, itemCount - 1));

  // Focus input on mount — autoFocus is unreliable across React versions
  // and portal contexts, so we explicitly focus after the first paint.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Position adjustment — measure actual popup height and place searchbox adjacent to trigger
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const gap = 4;
    const padding = 8;
    const popupWidth = 320;
    let left = position.left;

    // Horizontal clamp
    if (left + popupWidth > window.innerWidth - padding) {
      left = window.innerWidth - popupWidth - padding;
    }
    if (left < padding) left = padding;

    const height = el.getBoundingClientRect().height;
    const roomBelow = window.innerHeight - position.top - gap;
    const roomAbove = position.caretTop - gap;

    // Prefer below when possible
    if (height <= roomBelow) {
      setPlacement('below');
      setPopupPos({ top: position.top + gap, left });
    } else if (height <= roomAbove) {
      setPlacement('above');
      setPopupPos({ top: position.caretTop - height - gap, left });
    } else {
      // Not enough room either way; clamp to viewport and prefer below
      setPlacement('below');
      setPopupPos({ top: Math.max(padding, Math.min(position.top + gap, window.innerHeight - height - padding)), left });
    }
  }, [position]);

  // Create new node
  const createNode = useCreateNode();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();
  const { data: allClasses = [] } = useClasses();

  const handleCreate = useCallback(
    (name: string, mode: 'default' | 'alternative' = 'default') => {
      if (!pageClassId) return;
      const classes: number[] = [pageClassId];
      if (type === 'class' && classClassId) classes.push(classClassId);

      createNode.mutate(
        { name, classes },
        {
          onSuccess: (newNode) => {
            onSelectNode?.(newNode, mode);
          },
        }
      );
    },
    [createNode, pageClassId, classClassId, type, onSelectNode]
  );

  const getDisplayClasses = useCallback((node: Node): Array<{ id: number; name: string }> => {
    if (!node.classes || node.classes.length === 0) return [];
    return node.classes
      .map(classId => {
        const classNode = allClasses.find(c => c.id === classId);
        if (!classNode || classNode.uuid === SYSTEM_CLASS_UUIDS.page) return null;
        const name = nodeNameToText(classNode.name);
        if (!name) return null;
        return { id: classId, name };
      })
      .filter((c): c is { id: number; name: string } => c !== null);
  }, [allClasses]);

  // Keyboard handling
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => Math.min(Math.max(i, 0) + 1, itemCount - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => Math.max(Math.min(i, itemCount - 1) - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const mode: 'default' | 'alternative' =
          e.shiftKey || e.ctrlKey || e.metaKey ? 'alternative' : 'default';

        if (effectiveSelectedIndex < items.length) {
          if (isNodeTrigger) {
            onSelectNode?.(nodeItems[effectiveSelectedIndex].node, mode);
          } else {
            const cmdId = commandItems[effectiveSelectedIndex].id;
            bumpCommandUsage(cmdId);
            onSelectCommand?.(cmdId);
          }
        } else if (isNodeTrigger && showCreateOption && query.trim()) {
          handleCreate(query.trim(), mode);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (query.length === 0) {
          e.preventDefault();
          e.stopPropagation();
          onDeletePlaceholder?.();
        }
      }
    },
    [
      itemCount,
      effectiveSelectedIndex,
      items,
      isNodeTrigger,
      nodeItems,
      commandItems,
      showCreateOption,
      query,
      onSelectNode,
      onSelectCommand,
      onClose,
      onDeletePlaceholder,
      handleCreate,
      bumpCommandUsage,
    ]
  );

  // Hints
  const hints = useMemo(() => {
    switch (type) {
      case 'class':
        return { default: '↵ Add silently', alternative: '⇧↵ Insert pill' };
      case 'link':
        return { default: '↵ Insert link', alternative: '⇧↵ Insert & edit' };
      case 'tag':
        return { default: '↵ Insert tag', alternative: '⇧↵ Insert & edit' };
      case 'slash':
        return { default: '↵ Execute', alternative: '' };
    }
  }, [type]);

  const headerText = useMemo(() => {
    switch (type) {
      case 'class':
        return '+ Add Class';
      case 'link':
        return '@ Insert Link';
      case 'tag':
        return '# Insert Tag';
      case 'slash':
        return '/ Commands';
    }
  }, [type]);

  const header = <div className="trigger-popup__header">{headerText}</div>;

  const search = (
    <div className="trigger-popup__search">
      <input
        ref={inputRef}
        type="text"
        value={query}
        autoFocus
        onChange={(e) => {
          setQuery(e.target.value);
          setSelectedIndex(0);
        }}
        onKeyDown={handleKeyDown}
        placeholder={type === 'slash' ? 'Search commands...' : 'Search...'}
        className="trigger-popup__input"
      />
    </div>
  );

  const list = (
    <div className="trigger-popup__list">
      {isLoading && query.length > 0 ? (
        <div className="trigger-popup__loading">
          <Spinner size="sm" />
        </div>
      ) : items.length === 0 && !(isNodeTrigger && showCreateOption && query.trim()) ? (
        <div className="trigger-popup__empty">
          {query
            ? 'No matches'
            : type === 'slash'
              ? 'Type to filter commands'
              : 'Start typing to search'}
        </div>
      ) : (
        <>
          {isNodeTrigger &&
            nodeItems.map((item, index) => (
              <NodeResultItem
                key={item.node.id}
                node={item.node}
                displayClasses={getDisplayClasses(item.node)}
                allClasses={allClasses}
                isHighlighted={index === effectiveSelectedIndex}
                onClick={() => onSelectNode?.(item.node, 'default')}
                onMouseEnter={() => setSelectedIndex(index)}
              />
            ))}

          {!isNodeTrigger &&
            commandItems.map((cmd, index) => (
              <button
                key={cmd.id}
                className={`trigger-popup__command ${
                  index === effectiveSelectedIndex ? 'trigger-popup__command--selected' : ''
                }`}
                onClick={() => onSelectCommand?.(cmd.id)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="trigger-popup__command-label">{cmd.label}</span>
                <span className="trigger-popup__command-desc">{cmd.description}</span>
              </button>
            ))}

          {isNodeTrigger && showCreateOption && query.trim() && (
            <button
              className={`trigger-popup__create ${
                effectiveSelectedIndex === items.length ? 'trigger-popup__create--selected' : ''
              }`}
              onClick={() => handleCreate(query.trim())}
              onMouseEnter={() => setSelectedIndex(items.length)}
            >
              <AddIcon size="sm" />
              Create &quot;{query.trim()}&quot;
            </button>
          )}
        </>
      )}
    </div>
  );

  const footer = (
    <div className="trigger-popup__footer">
      <span className="trigger-popup__hint">{hints.default}</span>
      {hints.alternative && (
        <span className="trigger-popup__hint">{hints.alternative}</span>
      )}
    </div>
  );

  const popup = (
    <div
      ref={containerRef}
      data-editor-companion
      className={`trigger-popup trigger-popup--${type} ${placement === 'above' ? 'trigger-popup--above' : ''}`}
      style={{
        position: 'fixed',
        top: popupPos.top,
        left: popupPos.left,
        zIndex: 1000,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {placement === 'below' ? (
        <>
          {header}
          {search}
          {list}
          {footer}
        </>
      ) : (
        <>
          {list}
          {footer}
          {header}
          {search}
        </>
      )}
    </div>
  );

  return createPortal(popup, document.body);
}
