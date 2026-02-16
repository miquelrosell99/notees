/**
 * BlockPropertyIconsPlugin — Page-level property index approach.
 *
 * Architecture:
 * 1. ONE pass over the Lexical tree → extract all block serverIds
 * 2. ONE batch query → fetch property values for all blocks
 * 3. Build a Map<blockId, PropertyIconEntry[]> index
 * 4. Render icons from the pre-computed index via portals
 *
 * Blocks are dumb renderers. Zero per-block queries. O(1) lookup.
 */

import { useEffect, useState, useCallback, useRef, useMemo, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import {
  useProperties,
  useBatchPropertyValues,
  useSetNodeProperty,
} from '@/hooks';
import type { Property, SelectionOption } from '@/types/api';
import { NodeIcon } from '@/components/core/icons';
import './BlockPropertyIconsPlugin.css';

// ─── Types ────────────────────────────────────────────────────────

/** DOM info extracted from one Lexical pass */
interface BlockDOMInfo {
  blockId: string;
  serverId: number;
  afterBulletContainer: HTMLElement;
  beforeContentContainer: HTMLElement;
}

/** Pre-computed icon entry, ready to render */
interface PropertyIconEntry {
  property: Property;
  currentOption: SelectionOption | null;
}

// ─── Dropdown for selection change ───────────────────────────────

function PropertyIconButton({
  property,
  currentOption,
  serverId,
}: {
  property: Property;
  currentOption: SelectionOption | null;
  serverId: number;
}) {
  const [showDropdown, setShowDropdown] = useState(false);
  const setNodeProperty = useSetNodeProperty();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowDropdown(prev => !prev);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        buttonRef.current && !buttonRef.current.contains(e.target as Node) &&
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showDropdown]);

  const handleSelect = useCallback((optionId: number) => {
    setNodeProperty.mutate({ nodeId: serverId, propertyId: property.id, value: optionId });
    setShowDropdown(false);
  }, [serverId, property.id, setNodeProperty]);

  const iconName = currentOption?.icon;

  return (
    <span className="block-prop-icon-wrapper">
      <button
        ref={buttonRef}
        className="block-prop-icon-btn"
        onClick={handleClick}
        title={`${property.name}: ${currentOption?.name ?? 'Not set'}`}
      >
        {iconName ? (
          <NodeIcon icon={iconName} size="xs" />
        ) : (
          <span className="block-prop-icon-empty" />
        )}
      </button>
      {showDropdown && buttonRef.current && createPortal(
        <div
          ref={dropdownRef}
          className="block-prop-icon-dropdown"
          style={{
            position: 'fixed',
            top: buttonRef.current.getBoundingClientRect().bottom + 4,
            left: buttonRef.current.getBoundingClientRect().left,
            zIndex: 9999,
          }}
        >
          <div className="block-prop-icon-dropdown-inner">
            {property.options.map(opt => (
              <button
                key={opt.id}
                className={`block-prop-icon-dropdown-item${currentOption?.id === opt.id ? ' block-prop-icon-dropdown-item--active' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleSelect(opt.id); }}
              >
                {opt.icon && <NodeIcon icon={opt.icon} size="xs" />}
                <span>{opt.name}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}

// ─── Main Plugin ────────────────────────────────────────────────

export function BlockPropertyIconsPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const { data: allProperties } = useProperties();
  const [blockDOMs, setBlockDOMs] = useState<BlockDOMInfo[]>([]);

  // ── Step 0: Which properties care about icon visibility? ──────
  const visibleAfterBullet = useMemo(
    () => (allProperties ?? []).filter(p => p.type === 'selection' && p.icon_visibility === 'after_bullet'),
    [allProperties],
  );
  const visibleBeforeContent = useMemo(
    () => (allProperties ?? []).filter(p => p.type === 'selection' && p.icon_visibility === 'before_content'),
    [allProperties],
  );
  const visibleProps = useMemo(
    () => [...visibleAfterBullet, ...visibleBeforeContent],
    [visibleAfterBullet, visibleBeforeContent],
  );
  const hasVisibleProps = visibleProps.length > 0;

  // ── Step 1: ONE pass — scan blocks, extract serverIds + DOM refs ─
  const scanBlocks = useCallback(() => {
    if (!hasVisibleProps) return;
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const runtime = getNodeGraphRuntime();

    editor.getEditorState().read(() => {
      const root = $getRoot();
      const infos: BlockDOMInfo[] = [];

      for (const child of root.getChildren()) {
        if (!$isBlockNode(child)) continue;

        const blockId = child.getBlockId();
        const graphNode = runtime.getNode(blockId);
        if (!graphNode?.serverId) continue;

        const blockEl = rootEl.querySelector(`[data-block-id="${blockId}"]`);
        if (!blockEl) continue;

        const afterBulletContainer = blockEl.querySelector('.node-block-prop-icons--after-bullet') as HTMLElement;
        const beforeContentContainer = blockEl.querySelector('.node-block-prop-icons--before-content') as HTMLElement;
        if (!afterBulletContainer && !beforeContentContainer) continue;

        infos.push({
          blockId,
          serverId: graphNode.serverId,
          afterBulletContainer: afterBulletContainer!,
          beforeContentContainer: beforeContentContainer!,
        });
      }

      setBlockDOMs(infos);
    });
  }, [editor, hasVisibleProps]);

  // ── Step 2: Listen — only rescan on relevant structural changes ─
  useEffect(() => {
    if (!hasVisibleProps) return;
    scanBlocks();

    return editor.registerUpdateListener(({ dirtyElements, tags }) => {
      if (dirtyElements.size === 0 && !tags.has('runtime-sync')) return;
      Promise.resolve().then(scanBlocks);
    });
  }, [editor, scanBlocks, hasVisibleProps]);

  // ── Step 3: ONE batch query for all block property values ─────
  const serverIds = useMemo(
    () => blockDOMs.map(b => b.serverId),
    [blockDOMs],
  );
  const { data: batchProps } = useBatchPropertyValues(serverIds);

  // ── Step 4: Build the property index: Map<blockId, icons[]> ───
  const propertyIndex = useMemo(() => {
    const index = new Map<string, {
      afterBullet: PropertyIconEntry[];
      beforeContent: PropertyIconEntry[];
    }>();

    if (!batchProps) return index;

    for (const info of blockDOMs) {
      const nodeProps = batchProps[String(info.serverId)];
      if (!nodeProps) continue;

      const afterBulletEntries: PropertyIconEntry[] = [];
      const beforeContentEntries: PropertyIconEntry[] = [];

      for (const prop of visibleAfterBullet) {
        const val = nodeProps[String(prop.id)];
        if (val == null) continue;
        const selId = typeof val === 'number' ? val : null;
        const opt = selId != null ? prop.options.find(o => o.id === selId) ?? null : null;
        if (opt?.icon) afterBulletEntries.push({ property: prop, currentOption: opt });
      }

      for (const prop of visibleBeforeContent) {
        const val = nodeProps[String(prop.id)];
        if (val == null) continue;
        const selId = typeof val === 'number' ? val : null;
        const opt = selId != null ? prop.options.find(o => o.id === selId) ?? null : null;
        if (opt?.icon) beforeContentEntries.push({ property: prop, currentOption: opt });
      }

      if (afterBulletEntries.length > 0 || beforeContentEntries.length > 0) {
        index.set(info.blockId, {
          afterBullet: afterBulletEntries,
          beforeContent: beforeContentEntries,
        });
      }
    }

    return index;
  }, [batchProps, blockDOMs, visibleAfterBullet, visibleBeforeContent]);

  // ── Step 5: Render — dumb portals from pre-computed index ─────
  if (!hasVisibleProps || propertyIndex.size === 0) return null;

  return (
    <>
      {blockDOMs.map(info => {
        const entry = propertyIndex.get(info.blockId);
        if (!entry) return null;

        return (
          <span key={info.blockId}>
            {entry.afterBullet.length > 0 && info.afterBulletContainer && createPortal(
              <span className="block-prop-icons-inner">
                {entry.afterBullet.map(({ property, currentOption }) => (
                  <PropertyIconButton
                    key={property.id}
                    property={property}
                    currentOption={currentOption}
                    serverId={info.serverId}
                  />
                ))}
              </span>,
              info.afterBulletContainer,
            )}
            {entry.beforeContent.length > 0 && info.beforeContentContainer && createPortal(
              <span className="block-prop-icons-inner">
                {entry.beforeContent.map(({ property, currentOption }) => (
                  <PropertyIconButton
                    key={property.id}
                    property={property}
                    currentOption={currentOption}
                    serverId={info.serverId}
                  />
                ))}
              </span>,
              info.beforeContentContainer,
            )}
          </span>
        );
      })}
    </>
  );
}
