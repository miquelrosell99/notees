/**
 * TriggerPopup — Unified popup for all editor triggers (+, @, #, /).
 *
 * Features:
 * - Rendered via React portal to document.body (escapes editor DOM tree)
 * - Own search input field (no inline text pollution)
 * - Shift+Enter for alternative action
 * - Focus management (editor → popup → editor)
 * - Position adjustment to stay in viewport
 * - Filter pills: typing prefixes like user:, page:, class:, daily: adds filter pills
 * - Value picker: certain filters open an inline value selector
 */

import { useState, useRef, useEffect, useMemo, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Node } from '@/types';
import { useNodeSearch, type NodeSearchItem } from '@/hooks';
import { nodeNameToText } from '@/features/queries/hooks/useStringifyAST';
import { useClasses } from '@/features/content/hooks/useNodeQueries';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import { NodeResultItem } from '@/features/content/components/nodes/NodeResultItem';
import { useCreateNode } from '@/features/content/hooks/useNodes';
import { usePageClass, useClassClass } from '@/features/content/hooks/usePageClass';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { AddIcon } from '@/components/ui/icons';
import { Icon } from '@/components/ui/Icon';
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

// ─── Filter system ─────────────────────────────────────────────────

export interface ActiveFilter {
  key: string;
  label: string;
  value?: string;
}

interface FilterDef {
  key: string;
  label: string;
  prefix: string;
  icon: string;
  description: string;
  apply: () => { isUserPage?: boolean; isPage?: boolean; isClass?: boolean; isDaily?: boolean };
  hasValuePicker?: boolean;
}

const TRIGGER_FILTERS: FilterDef[] = [
  { key: 'user', label: 'user', prefix: 'user:', icon: 'mdi mdi-account', description: 'User pages only', apply: () => ({ isUserPage: true }), hasValuePicker: true },
  { key: 'page', label: 'page', prefix: 'page:', icon: 'mdi mdi-file-document', description: 'Pages only', apply: () => ({ isPage: true }) },
  { key: 'class', label: 'class', prefix: 'class:', icon: 'mdi mdi-tag', description: 'Classes only', apply: () => ({ isClass: true }) },
  { key: 'daily', label: 'daily', prefix: 'daily:', icon: 'mdi mdi-calendar-today', description: 'Daily notes only', apply: () => ({ isDaily: true }) },
];

/**
 * Scan query text for standalone filter tokens anywhere in the string.
 * A token is a filter if it exactly matches a filter prefix (e.g. "user:")
 * and is surrounded by whitespace (or start/end of string).
 *
 * Returns the query with confirmed-filter tokens removed, and any
 * newly-detected pending filter.
 */
function scanQueryFilters(
  query: string,
  activeFilters: ActiveFilter[],
  dismissedKeys: Set<string>,
): { cleanQuery: string; pendingFilter: FilterDef | null } {
  const tokens = query.split(/(\s+)/);
  const cleanTokens: string[] = [];
  let pendingFilter: FilterDef | null = null;

  for (const token of tokens) {
    const lowerToken = token.toLowerCase().trim();
    if (!lowerToken) {
      cleanTokens.push(token);
      continue;
    }
    const matched = TRIGGER_FILTERS.find(
      (f) =>
        f.prefix === lowerToken &&
        !activeFilters.some((a) => a.key === f.key) &&
        !dismissedKeys.has(f.key),
    );
    if (matched) {
      pendingFilter = matched;
      // Drop this token from cleanQuery — it's shown as a suggestion
    } else {
      cleanTokens.push(token);
    }
  }

  return { cleanQuery: cleanTokens.join(''), pendingFilter };
}

export interface TriggerPopupProps {
  type: TriggerPopupType;
  position: { top: number; left: number; caretTop: number };
  onSelectNode?: (node: Node, mode: 'default' | 'alternative', isUserMention: boolean) => void;
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
  const [placement, setPlacement] = useState<'below' | 'above'>(() => {
    const estimatedHeight = 280;
    const gap = 4;
    const roomBelow = window.innerHeight - position.top - gap;
    const roomAbove = position.caretTop - gap;
    if (estimatedHeight <= roomBelow) return 'below';
    if (estimatedHeight <= roomAbove) return 'above';
    return 'below';
  });
  const [popupPos, setPopupPos] = useState<{ top: number; left: number }>({ top: position.top, left: position.left });
  const [isPositioned, setIsPositioned] = useState(false);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [dismissedFilterKeys, setDismissedFilterKeys] = useState<Set<string>>(new Set());
  const [valuePickerFilter, setValuePickerFilter] = useState<FilterDef | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isNodeTrigger = type !== 'slash';

  // Scan query for filter tokens anywhere in the text.
  // Confirmed active filters are NOT re-detected; dismissed filters are ignored.
  const { cleanQuery, pendingFilter } = useMemo(
    () => scanQueryFilters(query, activeFilters, dismissedFilterKeys),
    [query, activeFilters, dismissedFilterKeys]
  );

  // Clear dismissed filters when the query changes enough that the user
  // might want to re-try (e.g. they backspaced and re-typed).
  // We keep it simple: clear all dismissed on any query change.
  // If this feels too eager we can refine later.
  useEffect(() => {
    if (dismissedFilterKeys.size > 0) {
      setDismissedFilterKeys(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Determine search mode and filter props from active filters
  const searchMode = type === 'class' ? 'classes' : type === 'tag' ? 'tags' : 'all';
  const filterProps = useMemo(() => {
    const props: { isUserPage?: boolean; isPage?: boolean; isClass?: boolean; isDaily?: boolean } = {};
    for (const f of activeFilters) {
      const def = TRIGGER_FILTERS.find(d => d.key === f.key);
      if (def) Object.assign(props, def.apply());
    }
    return props;
  }, [activeFilters]);

  const isUserMention = activeFilters.some(f => f.key === 'user');

  const { pageResults, blockResults, isLoading, showCreateOption } = useNodeSearch(
    cleanQuery,
    {
      mode: searchMode,
      maxResults: 10,
      ...filterProps,
    }
  );

  const nodeItems: NodeSearchItem[] = useMemo(
    () => [...pageResults, ...blockResults],
    [pageResults, blockResults]
  );

  // Value picker data (for user filter)
  const { pageResults: userPickerResults } = useNodeSearch(
    '',
    { mode: 'all', maxResults: 50, isUserPage: true }
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

  // Build the combined list of selectable items
  const { selectableItems } = useMemo(() => {
    const items: Array<
      | { kind: 'filter'; filter: FilterDef }
      | { kind: 'node'; item: NodeSearchItem }
      | { kind: 'command'; cmd: SlashCommand }
    > = [];

    if (type !== 'slash') {
      // Pending filter suggestion (only if query is non-empty and no value picker)
      if (pendingFilter && !valuePickerFilter) {
        items.push({ kind: 'filter', filter: pendingFilter });
      }
      // Node results
      for (const item of nodeItems) {
        items.push({ kind: 'node', item });
      }
    } else {
      // Slash commands
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
      for (const s of scored) {
        items.push({ kind: 'command', cmd: s.cmd });
      }
    }

    return { selectableItems: items };
  }, [type, pendingFilter, valuePickerFilter, nodeItems, query, commandUsage]);

  const showCreate = isNodeTrigger && showCreateOption && cleanQuery.trim() && !valuePickerFilter;
  const itemCount = selectableItems.length + (showCreate ? 1 : 0);

  // Clamp selected index
  const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(0, itemCount - 1));

  // Focus input on mount
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

  // Position adjustment
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const gap = 4;
    const padding = 8;
    const popupWidth = 320;
    let left = position.left;

    if (left + popupWidth > window.innerWidth - padding) {
      left = window.innerWidth - popupWidth - padding;
    }
    if (left < padding) left = padding;

    const height = el.getBoundingClientRect().height;
    const roomBelow = window.innerHeight - position.top - gap;
    const roomAbove = position.caretTop - gap;

    if (height <= roomBelow) {
      setPlacement('below');
      setPopupPos({ top: position.top + gap, left });
    } else if (height <= roomAbove) {
      setPlacement('above');
      setPopupPos({ top: position.caretTop - height - gap, left });
    } else {
      setPlacement('below');
      setPopupPos({ top: Math.max(padding, Math.min(position.top + gap, window.innerHeight - height - padding)), left });
    }
    setIsPositioned(true);
  }, [position]);

  // Create new node
  const createNode = useCreateNode();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();
  const { data: allClasses = [] } = useClasses();

  const bumpCommandUsage = useCallback((commandId: string) => {
    try {
      const next = { ...commandUsage, [commandId]: (commandUsage[commandId] || 0) + 1 };
      localStorage.setItem('notees_slash_cmd_usage', JSON.stringify(next));
    } catch {
      // ignore quota errors
    }
  }, [commandUsage]);

  const handleCreate = useCallback(
    (name: string, mode: 'default' | 'alternative' = 'default') => {
      if (!pageClassId) return;
      const classes: number[] = [pageClassId];
      if (type === 'class' && classClassId) classes.push(classClassId);

      createNode.mutate(
        { name, classes },
        {
          onSuccess: (newNode) => {
            onSelectNode?.(newNode, mode, false);
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

  // ─── Filter actions ──────────────────────────────────────────────

  const addFilter = useCallback((filter: FilterDef) => {
    if (activeFilters.some(f => f.key === filter.key)) return;
    const newFilter: ActiveFilter = { key: filter.key, label: filter.label };
    setActiveFilters(prev => [...prev, newFilter]);
    if (filter.hasValuePicker) {
      setValuePickerFilter(filter);
    }
    // Remove the filter token from anywhere in the query
    setQuery(prev => {
      const regex = new RegExp(`(^|\\s)${filter.prefix}(?=\\s|$)`, 'gi');
      return prev.replace(regex, '$1').replace(/\s+/g, ' ').trim();
    });
    setSelectedIndex(0);
  }, [activeFilters]);

  const removeFilter = useCallback((key: string) => {
    setActiveFilters(prev => prev.filter(f => f.key !== key));
    if (valuePickerFilter?.key === key) {
      setValuePickerFilter(null);
    }
    setSelectedIndex(0);
  }, [valuePickerFilter]);

  const dismissPendingFilter = useCallback((filterKey: string) => {
    setDismissedFilterKeys(prev => new Set([...prev, filterKey]));
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, []);

  const confirmValuePicker = useCallback((filterKey: string, valueLabel: string) => {
    setActiveFilters(prev =>
      prev.map(f => (f.key === filterKey ? { ...f, value: valueLabel } : f))
    );
    setValuePickerFilter(null);
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, []);

  const closeValuePicker = useCallback(() => {
    setValuePickerFilter(null);
    inputRef.current?.focus();
  }, []);

  // ─── Keyboard handling ───────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (valuePickerFilter) {
        // Value picker mode: simple list navigation
        const pickerItems = userPickerResults.length;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => Math.min(i + 1, pickerItems - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          if (valuePickerFilter.key === 'user' && userPickerResults[selectedIndex]) {
            confirmValuePicker('user', nodeNameToText(userPickerResults[selectedIndex].node.name));
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeValuePicker();
        }
        return;
      }

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

        if (effectiveSelectedIndex < selectableItems.length) {
          const selected = selectableItems[effectiveSelectedIndex];
          if (selected.kind === 'filter') {
            addFilter(selected.filter);
          } else if (selected.kind === 'node') {
            onSelectNode?.(selected.item.node, mode, isUserMention);
          } else {
            const cmdId = selected.cmd.id;
            bumpCommandUsage(cmdId);
            onSelectCommand?.(cmdId);
          }
        } else if (showCreate) {
          handleCreate(cleanQuery.trim(), mode);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // If there's a pending filter suggestion, dismiss it instead of closing the popup
        if (pendingFilter) {
          dismissPendingFilter(pendingFilter.key);
        } else {
          onClose();
        }
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (query.length === 0 && activeFilters.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          // Remove last filter
          removeFilter(activeFilters[activeFilters.length - 1].key);
        } else if (query.length === 0) {
          e.preventDefault();
          e.stopPropagation();
          onDeletePlaceholder?.();
        }
      }
    },
    [
      valuePickerFilter,
      userPickerResults,
      itemCount,
      effectiveSelectedIndex,
      selectableItems,
      showCreate,
      cleanQuery,
      isUserMention,
      query,
      activeFilters,
      onSelectNode,
      onSelectCommand,
      onClose,
      onDeletePlaceholder,
      handleCreate,
      bumpCommandUsage,
      selectedIndex,
      pendingFilter,
      dismissPendingFilter,
      addFilter,
      removeFilter,
      confirmValuePicker,
      closeValuePicker,
    ]
  );

  // ─── Hints ───────────────────────────────────────────────────────

  const hints = useMemo(() => {
    if (valuePickerFilter) {
      return { default: '↵ Select', alternative: '' };
    }
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
  }, [type, valuePickerFilter]);

  const headerText = useMemo(() => {
    if (valuePickerFilter) {
      return `Select ${valuePickerFilter.label}`;
    }
    switch (type) {
      case 'class':
        return '+ Add Class';
      case 'link':
        return isUserMention ? '@ Mention User' : '@ Insert Link';
      case 'tag':
        return '# Insert Tag';
      case 'slash':
        return '/ Commands';
    }
  }, [type, isUserMention, valuePickerFilter]);

  // ─── Render helpers ──────────────────────────────────────────────

  const header = <div className="trigger-popup__header">{headerText}</div>;

  const filterPills = activeFilters.length > 0 && (
    <div className="trigger-popup__filter-pills">
      {activeFilters.map((filter) => (
        <span key={filter.key} className="trigger-popup__filter-pill">
          <span className="trigger-popup__filter-pill-label">
            {filter.key}
            {filter.value && `: ${filter.value}`}
          </span>
          <Button aria-label="Remove filter"
            variant="ghost"
            size="xs"
            icon="mdi mdi-close"
            className="trigger-popup__filter-pill-remove"
            onClick={() => removeFilter(filter.key)}
            title="Remove filter"
          />
        </span>
      ))}
    </div>
  );

  const search = (
    <div className="trigger-popup__search">
      {filterPills}
      <input
        ref={inputRef}
        type="text"
        value={cleanQuery}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelectedIndex(0);
        }}
        onKeyDown={handleKeyDown}
        placeholder={type === 'slash' ? 'Search commands...' : 'Search or type filter (user:, page:, class:, daily:)...'}
        className="trigger-popup__input"
      />
    </div>
  );

  const valuePickerList = useMemo(() => {
    if (!valuePickerFilter) return null;
    if (valuePickerFilter.key === 'user') {
      return (
        <div className="trigger-popup__list">
          {userPickerResults.length === 0 ? (
            <div className="trigger-popup__empty">No users found</div>
          ) : (
            userPickerResults.map((item, index) => (
              <NodeResultItem
                key={item.node.id}
                node={item.node}
                displayClasses={getDisplayClasses(item.node)}
                allClasses={allClasses}
                isHighlighted={index === selectedIndex}
                onClick={() => confirmValuePicker('user', nodeNameToText(item.node.name))}
                onMouseEnter={() => setSelectedIndex(index)}
              />
            ))
          )}
        </div>
      );
    }
    return null;
  }, [valuePickerFilter, userPickerResults, selectedIndex, getDisplayClasses, allClasses, confirmValuePicker]);

  const mainList = (
    <div className="trigger-popup__list">
      {isLoading && cleanQuery.length > 0 ? (
        <div className="trigger-popup__loading">
          <Spinner size="sm" />
        </div>
      ) : selectableItems.length === 0 && !showCreate ? (
        <div className="trigger-popup__empty">
          {cleanQuery || activeFilters.length > 0
            ? 'No matches'
            : type === 'slash'
              ? 'Type to filter commands'
              : 'Start typing to search'}
        </div>
      ) : (
        <>
          {selectableItems.map((item, index) => {
            if (item.kind === 'filter') {
              return (
                <button
                  key={`filter-${item.filter.key}`}
                  className={`trigger-popup__filter-suggestion ${
                    index === effectiveSelectedIndex ? 'trigger-popup__filter-suggestion--selected' : ''
                  }`}
                  onClick={() => addFilter(item.filter)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <span className="trigger-popup__filter-suggestion-icon">
                    <Icon path={item.filter.icon} size="14px" />
                  </span>
                  <span className="trigger-popup__filter-suggestion-label">
                    Filter: {item.filter.label}
                  </span>
                  <span className="trigger-popup__filter-suggestion-desc">
                    {item.filter.description}
                  </span>
                </button>
              );
            }
            if (item.kind === 'node') {
              return (
                <NodeResultItem
                  key={item.item.node.id}
                  node={item.item.node}
                  displayClasses={getDisplayClasses(item.item.node)}
                  allClasses={allClasses}
                  isHighlighted={index === effectiveSelectedIndex}
                  onClick={() => onSelectNode?.(item.item.node, 'default', isUserMention)}
                  onMouseEnter={() => setSelectedIndex(index)}
                />
              );
            }
            return (
              <button
                key={item.cmd.id}
                className={`trigger-popup__command ${
                  index === effectiveSelectedIndex ? 'trigger-popup__command--selected' : ''
                }`}
                onClick={() => {
                  bumpCommandUsage(item.cmd.id);
                  onSelectCommand?.(item.cmd.id);
                }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="trigger-popup__command-label">{item.cmd.label}</span>
                <span className="trigger-popup__command-desc">{item.cmd.description}</span>
              </button>
            );
          })}

          {showCreate && (
            <button
              className={`trigger-popup__create ${
                effectiveSelectedIndex === selectableItems.length ? 'trigger-popup__create--selected' : ''
              }`}
              onClick={() => handleCreate(cleanQuery.trim())}
              onMouseEnter={() => setSelectedIndex(selectableItems.length)}
            >
              <AddIcon size="sm" />
              Create &quot;{cleanQuery.trim()}&quot;
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
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={containerRef}
      data-editor-companion
      className={`trigger-popup trigger-popup--${type} ${placement === 'above' ? 'trigger-popup--above' : ''}`}
      style={{
        position: 'fixed',
        top: popupPos.top,
        left: popupPos.left,
        zIndex: 'var(--z-1000)',
        visibility: isPositioned ? 'visible' : 'hidden',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label={headerText}
      tabIndex={-1}
    >
      {placement === 'below' ? (
        <>
          {header}
          {search}
          {valuePickerFilter ? valuePickerList : mainList}
          {footer}
        </>
      ) : (
        <>
          {valuePickerFilter ? valuePickerList : mainList}
          {footer}
          {header}
          {search}
        </>
      )}
    </div>
  );

  return createPortal(popup, document.body);
}
