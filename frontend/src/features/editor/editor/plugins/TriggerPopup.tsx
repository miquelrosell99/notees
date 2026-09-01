/**
 * TriggerPopup — Unified popup for all editor triggers (+, @, #, /).
 *
 * Features:
 * - Rendered via React portal to document.body (escapes editor DOM tree)
 * - Own search input field (no inline text pollution)
 * - Shift+Enter for alternative action
 * - Focus management (editor → popup → editor)
 * - Floating UI positioning — flips above the caret and stays in the viewport
 * - Filter pills: typing prefixes like user:, page:, class:, daily: adds filter pills
 * - Value picker: certain filters open an inline value selector
 */

import { useState, useRef, useEffect, useMemo, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { autoUpdate, computePosition, flip, offset, shift, type VirtualElement } from '@floating-ui/dom';
import type { Node } from '@/types';
import { useNodeSearch, type NodeSearchItem } from '@/features/content';
import { nodeNameToText, nodeNameToDisplayText } from '@/features/queries';
import { useClasses, usePages } from '@/features/content';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import { useSettingsStore } from '@/stores';
import { getWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';
import type { NodeRow } from '@/core/store';
import { classRowToNode, type ClassRow } from '@/core/query/classes';
import { uuidv7 } from '@/core/uuid';
import { NodeResultItem } from '@/features/content';
import { useCreateNode } from '@/features/content';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { AddIcon, Icon } from '@/components/ui/icons';
import { useOverlaySurface } from '@/hooks/useOverlaySurface';
import { getRegisteredSlashCommands } from '@/plugins/core';
import {
  resolveClassAwareCreate,
  uploadAssetAsNode,
} from '@/features/content/utils/classAwareCreate';
import { SourceQuickCreateModal } from '@/features/content/components/nodes/SourceQuickCreateModal';
import { AgentQuickCreateModal } from '@/features/content/components/nodes/AgentQuickCreateModal';
import './TriggerPopup.css';

export type TriggerPopupType = 'class' | 'link' | 'tag' | 'slash';

interface SlashCommand {
  id: string;
  label: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'link', label: 'Insert Page Link', description: 'Link to a page' },
  { id: 'sourcelink', label: 'Link to Source', description: 'Link to a source (book, paper, article…)' },
  { id: 'blocklink', label: 'Insert Block Link', description: 'Link to a specific block' },
  { id: 'embed', label: 'Embed Node', description: 'Embed the full content of a node' },
  { id: 'url', label: 'Add URL', description: 'Add a URL link to external website' },
  { id: 'type', label: 'Add Class', description: 'Add a class to this block' },
  { id: 'tag', label: 'Add Tag', description: 'Add a tag to this block' },
  { id: 'property', label: 'Add property', description: 'Add a property to this block' },
  { id: 'query', label: 'Query', description: 'Assign query class to this block' },
  { id: 'table', label: 'Table', description: 'Convert block to table' },
  { id: 'code', label: 'Code Block', description: 'Convert block to code block' },
  { id: 'whiteboard', label: 'Whiteboard', description: 'Convert block to an inline whiteboard' },
  { id: 'task', label: 'Task', description: 'Convert block to task' },
  { id: 'comment', label: 'Add comment', description: 'Add a comment to this block' },
  { id: 'image', label: 'Insert image', description: 'Upload an image' },
  { id: 'audio', label: 'Insert audio', description: 'Upload an audio file' },
  { id: 'file', label: 'Insert file', description: 'Upload any supported file' },
  { id: 'template', label: 'Add template', description: 'Insert content from a template' },
  { id: 'date', label: 'Date', description: 'Insert a link to a daily journal page' },
  { id: 'date-range', label: 'Date Range', description: 'Insert a date range' },
  { id: 'flashcard', label: 'Flashcard', description: 'Convert this block into a flashcard' },
  { id: 'cloze', label: 'Cloze', description: 'Mark this block as a cloze deletion' },
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
  /** Caret anchor in VIEWPORT coordinates: `top` = caret bottom, `caretTop` = caret top (the popup is position: fixed) */
  position: { top: number; left: number; caretTop: number };
  onSelectNode?: (node: Node, mode: 'default' | 'alternative', isUserMention: boolean) => void;
  onSelectCommand?: (commandId: string) => void;
  onClose: () => void;
  /** Called when user presses Backspace/Delete to remove the trigger placeholder */
  onDeletePlaceholder?: () => void;
  /** Slash command ids that should not be shown in this popup */
  hiddenSlashCommandIds?: Set<string>;
  /** Server ID (UUID) of the block that opened this popup, used for context-aware filtering */
  contextBlockServerId?: string;
  /** Constrains the link popup (`type === 'link'`) to a subset of nodes (e.g. blocks only) */
  linkSearchMode?: 'all' | 'pages' | 'blocks';
  /** Class IDs to filter link results by (nodes must have at least one of these classes) */
  classFilters?: string[];
  /** Node IDs hidden from class results (e.g. classes already applied to the target node) */
  excludeNodeIds?: readonly string[];
  /** Precomputed "parent has the card system class" flag. When provided, the
   * context-block lookup below is skipped (used by non-editor hosts that
   * already know the answer, e.g. the class-pills row). */
  parentIsCard?: boolean;
  /** Workspace ID used to look up the context block in the core store. */
  workspaceId?: string;
  /**
   * Inline mode: the editor block is the filter field (slash only). The popup has no
   * search input, does not steal focus, and is driven by the parent.
   */
  inline?: boolean;
  /** Query source when `inline` (text after the trigger in the block) */
  controlledQuery?: string;
  /** Highlight index owned by the parent when `inline` */
  controlledSelectedIndex?: number;
  /** Reports the highlighted slash command + list size for parent `Enter` handling */
  onActiveCommandChange?: (commandId: string | null, itemCount: number) => void;
  /** Hover highlight changes (inline mode) — parent owns the index */
  onHighlightChange?: (index: number) => void;
}

export function TriggerPopup({
  type,
  position,
  onSelectNode,
  onSelectCommand,
  onClose,
  onDeletePlaceholder,
  hiddenSlashCommandIds,
  contextBlockServerId,
  linkSearchMode,
  classFilters,
  excludeNodeIds,
  parentIsCard: parentIsCardProp,
  workspaceId,
  inline = false,
  controlledQuery,
  controlledSelectedIndex,
  onActiveCommandChange,
  onHighlightChange,
}: TriggerPopupProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [linkTab, setLinkTab] = useState<'all' | 'pages' | 'blocks'>('all');
  const [displayLimit, setDisplayLimit] = useState(10);
  const dateFormat = useSettingsStore((s) => s.dateFormat);

  const isInlineSlash = inline && type === 'slash';
  // In inline mode the editor block drives the query; otherwise the popup owns it.
  const effectiveQuery = isInlineSlash ? (controlledQuery ?? '') : query;

  const allSlashCommands = useMemo<SlashCommand[]>(() => {
    const pluginCommands = getRegisteredSlashCommands().map((cmd) => ({
      id: cmd.id,
      label: cmd.label,
      description: cmd.description ?? '',
    }));
    return [...SLASH_COMMANDS, ...pluginCommands];
  }, []);

  // Set by Floating UI's resolved placement: 'above' reverses the layout so the
  // search bar stays next to the caret while the popup grows upward.
  const [placement, setPlacement] = useState<'below' | 'above'>('below');
  const [isPositioned, setIsPositioned] = useState(false);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [dismissedFilterKeys, setDismissedFilterKeys] = useState<Set<string>>(new Set());
  const [valuePickerFilter, setValuePickerFilter] = useState<FilterDef | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Register with the global overlay stack so Escape closes this popup even
  // when focus is still in the editor. Internal Escape-consuming states
  // (value picker / pending filter) are handled first.
  useOverlaySurface({
    type: 'popup',
    enabled: !isInlineSlash,
    onClose,
    onEscape: () => {
      if (valuePickerFilter) {
        closeValuePicker();
        return true;
      }
      if (pendingFilter) {
        dismissPendingFilter(pendingFilter.key);
        return true;
      }
      return false;
    },
  });

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

  // Context-aware filtering: only show the cloze class when the block's parent is a card.
  const { data: allClasses = [], isLoading: classesLoading } = useClasses();
  const { data: allPages = [] } = usePages();

  const [parentIsCardDetected, setParentIsCard] = useState(false);
  const parentIsCard = parentIsCardProp ?? parentIsCardDetected;

  useEffect(() => {
    if (parentIsCardProp !== undefined) return; // host provided the flag
    if (contextBlockServerId == null || workspaceId == null) {
      setParentIsCard(false);
      return;
    }
    const client = getWorkspaceStoreClient(workspaceId);
    if (!client) {
      setParentIsCard(false);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const blockNode = await client.query<NodeRow | undefined>('getNode', [contextBlockServerId]);
        if (!blockNode?.parentId) {
          if (!cancelled) setParentIsCard(false);
          return;
        }
        const parentNode = await client.query<NodeRow | undefined>('getNode', [blockNode.parentId]);
        if (!cancelled) {
          setParentIsCard(parentNode?.classIds.includes(SYSTEM_CLASS_UUIDS.card) ?? false);
        }
      } catch {
        if (!cancelled) setParentIsCard(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [parentIsCardProp, contextBlockServerId, workspaceId]);

  // Determine search mode and filter props from active filters
  const isLinkModeUnconstrained = type === 'link' && (!linkSearchMode || linkSearchMode === 'all');
  const showLinkTabs = isLinkModeUnconstrained;
  const effectiveSearchMode = useMemo(() => {
    if (type === 'class') return 'classes';
    if (type === 'tag') return 'tags';
    if (type === 'link') {
      if (!linkSearchMode || linkSearchMode === 'all') return linkTab;
      return linkSearchMode;
    }
    return 'all';
  }, [type, linkSearchMode, linkTab]);
  const filterProps = useMemo(() => {
    const props: { isUserPage?: boolean; isPage?: boolean; isClass?: boolean; isDaily?: boolean } = {};
    for (const f of activeFilters) {
      const def = TRIGGER_FILTERS.find(d => d.key === f.key);
      if (def) Object.assign(props, def.apply());
    }
    return props;
  }, [activeFilters]);

  const isUserMention = activeFilters.some(f => f.key === 'user');

  const {
    pageResults,
    blockResults,
    isLoading: searchLoading,
    showCreateOption: searchShowCreate,
    hasMore,
  } = useNodeSearch(
    cleanQuery,
    {
      mode: effectiveSearchMode,
      maxResults: displayLimit,
      classFilters: type === 'link' ? classFilters : undefined,
      ...filterProps,
    }
  );

  const nodeItems: NodeSearchItem[] = useMemo(
    () => {
      if (type === 'class') {
        const normalized = cleanQuery.toLowerCase().trim();
        const excluded = new Set(excludeNodeIds ?? []);
        let items = allClasses.filter((c) => !excluded.has(c.uuid));
        if (normalized) {
          items = items.filter((c) => c.name.toLowerCase().includes(normalized));
        }
        if (!parentIsCard) {
          items = items.filter((c) => c.uuid !== SYSTEM_CLASS_UUIDS.cloze);
        }
        return items.slice(0, 10).map((node) => ({ node, section: 'class' as const }));
      }
      const items = [...pageResults, ...blockResults];
      return items;
    },
    [allClasses, pageResults, blockResults, type, parentIsCard, cleanQuery, excludeNodeIds],
  );

  const isLoading = type === 'class' ? classesLoading : searchLoading;
  const showCreateOption = type === 'class'
    // Match against all classes, not the visible (possibly excluded) subset, so
    // typing the exact name of an already-applied class doesn't offer a duplicate.
    ? cleanQuery.trim().length > 0 && !allClasses.some((c) => nodeNameToText(c.name) === cleanQuery.trim())
    : showLinkTabs && linkTab === 'blocks'
      ? false
      : searchShowCreate;

  // Class-aware create flow (Decisions 17-19): under a source/agent/asset
  // class filter, "create" opens the matching quick-create flow instead of
  // creating a plain page.
  const createPlan = useMemo(
    () => (type === 'link' && classFilters && classFilters.length > 0
      ? resolveClassAwareCreate(classFilters, allClasses)
      : null),
    [type, classFilters, allClasses],
  );
  const isAssetCreate = createPlan?.kind === 'asset';
  const [classCreateModalOpen, setClassCreateModalOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      const lower = effectiveQuery.toLowerCase();
      const scored = allSlashCommands
        .filter((c) => !hiddenSlashCommandIds?.has(c.id))
        .map((c) => {
          const labelMatch = c.label.toLowerCase().includes(lower);
          const descMatch = c.description.toLowerCase().includes(lower);
          const textScore = (labelMatch ? 2 : 0) + (descMatch ? 1 : 0);
          return { cmd: c, textScore, freq: commandUsage[c.id] || 0 };
        }).filter((s) => s.textScore > 0 || !effectiveQuery);
      scored.sort((a, b) => {
        if (b.textScore !== a.textScore) return b.textScore - a.textScore;
        return b.freq - a.freq;
      });
      for (const s of scored) {
        items.push({ kind: 'command', cmd: s.cmd });
      }
    }

    return { selectableItems: items };
  }, [type, pendingFilter, valuePickerFilter, nodeItems, effectiveQuery, commandUsage, hiddenSlashCommandIds, allSlashCommands]);

  const showCreate = isNodeTrigger && !valuePickerFilter &&
    (isAssetCreate || (showCreateOption && !!cleanQuery.trim()));
  const showMore = type === 'link' && hasMore && !valuePickerFilter;
  const itemCount = selectableItems.length + (showCreate ? 1 : 0) + (showMore ? 1 : 0);

  // Clamp selected index (parent-owned in inline mode)
  const baseIndex = isInlineSlash ? (controlledSelectedIndex ?? 0) : selectedIndex;
  const effectiveSelectedIndex = Math.min(baseIndex, Math.max(0, itemCount - 1));

  // Focus input on mount (skipped in inline mode — focus stays in the editor)
  useEffect(() => {
    if (isInlineSlash) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [isInlineSlash]);

  // Report the highlighted slash command + list size to the parent (inline mode).
  const activeCommandId = useMemo(() => {
    if (!isInlineSlash) return null;
    const item = selectableItems[effectiveSelectedIndex];
    return item?.kind === 'command' ? item.cmd.id : null;
  }, [isInlineSlash, selectableItems, effectiveSelectedIndex]);

  useEffect(() => {
    if (!isInlineSlash) return;
    onActiveCommandChange?.(activeCommandId, itemCount);
  }, [isInlineSlash, activeCommandId, itemCount, onActiveCommandChange]);

  // Keep the keyboard-highlighted list item visible as the selection moves.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector('.trigger-popup__item--selected') as HTMLElement | null;
    if (selected && typeof selected.scrollIntoView === 'function') {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [effectiveSelectedIndex]);

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

  // If every slash command is hidden, close the popup so the user isn't shown
  // an empty menu.
  useEffect(() => {
    if (type === 'slash' && allSlashCommands.every((c) => hiddenSlashCommandIds?.has(c.id))) {
      onClose();
    }
  }, [type, hiddenSlashCommandIds, onClose, allSlashCommands]);

  // Position the popup with Floating UI against a virtual element that spans
  // the caret line (caretTop → top). computePosition measures the real popup
  // size for exact flip/shift decisions — no estimated-height guesswork — and
  // autoUpdate re-anchors on scroll (any ancestor), resize, element resize,
  // and layout shifts. `position` is in viewport coordinates (the popup is
  // position: fixed); top/left are written imperatively so repositioning never
  // goes through React renders.
  useLayoutEffect(() => {
    const floating = containerRef.current;
    if (!floating) return;

    const reference: VirtualElement = {
      getBoundingClientRect: () => ({
        x: position.left,
        y: position.caretTop,
        width: 0,
        height: position.top - position.caretTop,
        top: position.caretTop,
        left: position.left,
        right: position.left,
        bottom: position.top,
      }),
    };

    const update = () => {
      computePosition(reference, floating, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [
          offset(4),
          flip({ padding: 8, fallbackPlacements: ['top-start'] }),
          shift({ padding: 8, crossAxis: true }),
        ],
      }).then(({ x, y, placement: resolved }) => {
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
        setPlacement(resolved.startsWith('top') ? 'above' : 'below');
        setIsPositioned(true);
      });
    };

    update();
    return autoUpdate(reference, floating, update);
  }, [position]);

  // Create new node
  const createNode = useCreateNode();

  const pageById = useMemo(() => {
    const m = new Map<string, Node>();
    for (const p of allPages) m.set(p.uuid, p);
    return m;
  }, [allPages]);

  const buildParentPath = useCallback((node: Node): string => {
    if (!node.parent_uuid) return '';
    const segments: string[] = [];
    let currentId: string | null = node.parent_uuid;
    while (currentId !== null) {
      const parent = pageById.get(currentId);
      if (!parent || !parent.is_page) break;
      segments.unshift(nodeNameToDisplayText(parent, { dateFormat }) || 'Untitled');
      currentId = parent.parent_uuid ?? null;
    }
    return segments.join(' / ');
  }, [pageById, dateFormat]);

  const buildBlockParentPath = useCallback((node: Node): string => {
    if (!node.page_uuid) return '';
    const page = pageById.get(node.page_uuid);
    if (!page) return '';
    const pageName = nodeNameToDisplayText(page, { dateFormat }) || 'Untitled';
    const ancestors = buildParentPath(page);
    return ancestors ? `${ancestors} / ${pageName}` : pageName;
  }, [pageById, buildParentPath, dateFormat]);

  const bumpCommandUsage = useCallback((commandId: string) => {
    try {
      const next = { ...commandUsage, [commandId]: (commandUsage[commandId] || 0) + 1 };
      localStorage.setItem('notees_slash_cmd_usage', JSON.stringify(next));
    } catch {
      // ignore quota errors
    }
  }, [commandUsage]);

  const handleCreate = useCallback(
    async (name: string, mode: 'default' | 'alternative' = 'default') => {
      // Class-aware create flows (Decisions 17-19)
      if (createPlan?.kind === 'asset') {
        fileInputRef.current?.click();
        return;
      }
      if (createPlan?.kind === 'source' || createPlan?.kind === 'agent') {
        setClassCreateModalOpen(true);
        return;
      }

      const plainName = nodeNameToText(name) || name;
      if (type === 'class') {
        if (!workspaceId) return;
        const client = getWorkspaceStoreClient(workspaceId);
        if (!client) return;
        const classId = uuidv7();
        await client.mutate<void>('createClass', [{ classId, name: plainName }]);
        const classRow = await client.query<ClassRow | undefined>('getClass', [classId]);
        onSelectNode?.(classRowToNode(classRow!), mode, false);
        return;
      }
      createNode.mutate(
        { name, kind: 'page' },
        {
          onSuccess: (newNode) => {
            onSelectNode?.(newNode, mode, false);
          },
        }
      );
    },
    [createNode, type, onSelectNode, workspaceId, createPlan]
  );

  // Class-aware creation completed: insert/select the new node through the
  // same single insertion path as an existing-node pick.
  const handleClassAwareCreated = useCallback(
    (node: Node) => {
      setClassCreateModalOpen(false);
      onSelectNode?.(node, 'default', false);
    },
    [onSelectNode],
  );

  // Asset-filtered create: file selector -> upload -> insert the asset node.
  const handleAssetFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset so selecting the same file twice still fires onChange.
      e.target.value = '';
      if (!file || !workspaceId) return;
      const client = getWorkspaceStoreClient(workspaceId);
      if (!client) return;
      try {
        const node = await uploadAssetAsNode(client, file);
        onSelectNode?.(node, 'default', false);
      } catch (error) {
        console.error('Failed to upload asset:', error);
      }
    },
    [workspaceId, onSelectNode],
  );

  const getDisplayClasses = useCallback((node: Node): Array<{ nodeUuid: string; name: string }> => {
    if (!node.classes_uuid || node.classes_uuid.length === 0) return [];
    return node.classes_uuid
      .map(classId => {
        const classNode = allClasses.find(c => c.uuid === classId);
        if (!classNode) return null;
        const name = nodeNameToText(classNode.name);
        if (!name) return null;
        return { nodeUuid: classId, name };
      })
      .filter((c): c is { nodeUuid: string; name: string } => c !== null);
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
        } else if (showCreate && effectiveSelectedIndex === selectableItems.length) {
          handleCreate(cleanQuery.trim(), mode);
        } else if (showMore) {
          setDisplayLimit((prev) => prev + 20);
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
      showMore,
      cleanQuery,
      isUserMention,
      query,
      activeFilters,
      onSelectNode,
      onSelectCommand,
      onDeletePlaceholder,
      handleCreate,
      bumpCommandUsage,
      selectedIndex,
      addFilter,
      removeFilter,
      confirmValuePicker,
      closeValuePicker,
      setDisplayLimit,
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
  // Each section has a stable key because the popup reorders its children
  // when Floating UI flips placement above/below the caret. Without keys,
  // React unmounts and remounts the search input in its new position, which
  // blurs the field every time results load and change the popup's size.

  const header = <div key="header" className="trigger-popup__header">{headerText}</div>;

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
    <div key="search" className="trigger-popup__search">
      {filterPills}
      <input
        ref={inputRef}
        type="text"
        value={cleanQuery}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelectedIndex(0);
          setDisplayLimit(10);
        }}
        onKeyDown={handleKeyDown}
        placeholder={type === 'slash' ? 'Search commands...' : 'Search or type filter (user:, page:, class:, daily:)...'}
        aria-label={type === 'slash' ? 'Search commands' : 'Search or type filter'}
        className="trigger-popup__input"
      />
    </div>
  );

  const linkTabs = showLinkTabs ? (
    <div key="link-tabs" className="trigger-popup__tabs">
      <SelectionButton
        options={[
          { value: 'all', icon: 'mdi mdi-view-list', label: 'All' },
          { value: 'pages', icon: 'mdi mdi-file-document', label: 'Pages' },
          { value: 'blocks', icon: 'mdi mdi-text-box', label: 'Blocks' },
        ]}
        value={linkTab}
        onChange={(v) => {
          setLinkTab(v as 'all' | 'pages' | 'blocks');
          setSelectedIndex(0);
        }}
        size="sm"
      />
    </div>
  ) : null;

  const valuePickerList = useMemo(() => {
    if (!valuePickerFilter) return null;
    if (valuePickerFilter.key === 'user') {
      return (
        <div key="value-picker-list" className="trigger-popup__list">
          {userPickerResults.length === 0 ? (
            <div className="trigger-popup__empty">No users found</div>
          ) : (
            userPickerResults.map((item, index) => (
              <NodeResultItem
                key={item.node.uuid}
                node={item.node}
                parentPath={item.node.is_page ? buildParentPath(item.node) : buildBlockParentPath(item.node)}
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
  }, [valuePickerFilter, userPickerResults, selectedIndex, getDisplayClasses, allClasses, confirmValuePicker, buildParentPath, buildBlockParentPath]);

  const mainList = (
    <div key="main-list" ref={listRef} className="trigger-popup__list">
      {isLoading && cleanQuery.length > 0 ? (
        <div className="trigger-popup__loading">
          <Spinner size="sm" />
        </div>
      ) : selectableItems.length === 0 && !showCreate && !showMore ? (
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
            const isSelected = index === effectiveSelectedIndex;
            if (item.kind === 'filter') {
              return (
                <button
                  key={`filter-${item.filter.key}`}
                  className={`trigger-popup__filter-suggestion ${
                    isSelected ? 'trigger-popup__filter-suggestion--selected trigger-popup__item--selected' : ''
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
                  key={item.item.node.uuid}
                  node={item.item.node}
                  parentPath={item.item.node.is_page ? buildParentPath(item.item.node) : buildBlockParentPath(item.item.node)}
                  displayClasses={getDisplayClasses(item.item.node)}
                  allClasses={allClasses}
                  isHighlighted={isSelected}
                  onClick={() => onSelectNode?.(item.item.node, 'default', isUserMention)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={isSelected ? 'trigger-popup__item--selected' : ''}
                />
              );
            }
            return (
              <button
                key={item.cmd.id}
                className={`trigger-popup__command ${
                  isSelected ? 'trigger-popup__command--selected trigger-popup__item--selected' : ''
                }`}
                role={isInlineSlash ? 'option' : undefined}
                aria-selected={isInlineSlash ? isSelected : undefined}
                onClick={() => {
                  bumpCommandUsage(item.cmd.id);
                  onSelectCommand?.(item.cmd.id);
                }}
                onMouseEnter={() => (isInlineSlash ? onHighlightChange?.(index) : setSelectedIndex(index))}
              >
                <span className="trigger-popup__command-label">{item.cmd.label}</span>
                <span className="trigger-popup__command-desc">{item.cmd.description}</span>
              </button>
            );
          })}

          {showCreate && (
            <button
              className={`trigger-popup__create ${
                effectiveSelectedIndex === selectableItems.length ? 'trigger-popup__create--selected trigger-popup__item--selected' : ''
              }`}
              onClick={() => handleCreate(cleanQuery.trim())}
              onMouseEnter={() => setSelectedIndex(selectableItems.length)}
            >
              <AddIcon size="sm" />
              {isAssetCreate
                ? 'Upload file…'
                : createPlan?.kind === 'source'
                  ? `Create source "${cleanQuery.trim()}"`
                  : `Create "${cleanQuery.trim()}"`}
            </button>
          )}

          {showMore && (
            <button
              className={`trigger-popup__show-more ${
                effectiveSelectedIndex === selectableItems.length + (showCreate ? 1 : 0)
                  ? 'trigger-popup__show-more--selected trigger-popup__item--selected'
                  : ''
              }`}
              onClick={() => setDisplayLimit((prev) => prev + 20)}
              onMouseEnter={() => setSelectedIndex(selectableItems.length + (showCreate ? 1 : 0))}
            >
              Show more results
            </button>
          )}
        </>
      )}
    </div>
  );

  const footer = (
    <div key="footer" className="trigger-popup__footer">
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
      className={`trigger-popup trigger-popup--${type} ${placement === 'above' ? 'trigger-popup--above' : ''}${isInlineSlash ? ' trigger-popup--inline' : ''}`}
      style={{
        position: 'fixed',
        // top/left are written imperatively by Floating UI so repositioning
        // (scroll, resize, flip) never goes through React renders.
        zIndex: 'var(--z-1000)',
        visibility: isPositioned ? 'visible' : 'hidden',
        maxHeight: placement === 'above' ? position.caretTop - 4 : undefined,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      role={isInlineSlash ? 'listbox' : 'dialog'}
      aria-modal={isInlineSlash ? undefined : true}
      aria-label={headerText}
      tabIndex={-1}
    >
      {placement === 'below' ? (
        <>
          {header}
          {!isInlineSlash && search}
          {linkTabs}
          {valuePickerFilter ? valuePickerList : mainList}
          {footer}
        </>
      ) : (
        <>
          {valuePickerFilter ? valuePickerList : mainList}
          {footer}
          {header}
          {!isInlineSlash && search}
          {linkTabs}
        </>
      )}
    </div>
  );

  return (
    <>
      {createPortal(popup, document.body)}
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        aria-hidden="true"
        onChange={handleAssetFileSelected}
      />
      {createPlan?.kind === 'source' && (
        <SourceQuickCreateModal
          isOpen={classCreateModalOpen}
          initialTitle={cleanQuery.trim()}
          defaultClassUuid={createPlan.defaultClassUuid}
          onClose={() => setClassCreateModalOpen(false)}
          onCreated={handleClassAwareCreated}
        />
      )}
      {createPlan?.kind === 'agent' && (
        <AgentQuickCreateModal
          isOpen={classCreateModalOpen}
          initialName={cleanQuery.trim()}
          defaultAgentType={
            createPlan.defaultClassUuid === SYSTEM_CLASS_UUIDS.organization ? 'organization' : 'person'
          }
          onClose={() => setClassCreateModalOpen(false)}
          onCreated={handleClassAwareCreated}
        />
      )}
    </>
  );
}
