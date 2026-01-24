/**
 * Node Selector Components
 * 
 * Components for selecting nodes (types, pages) in the query builder.
 * Uses checkbox-based multi-select with selected items at the top.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  mdiPlus,
  mdiChevronDown,
  mdiTagOutline,
  mdiPageNextOutline,
} from '@mdi/js';
import Icon from '@mdi/react';
import { Button } from '../core/Button';
import { Card } from '../core/Card';
import { Checkbox } from '../core/Checkbox';
import { NodeTypePill } from '../NodeTypePill';
import { useTypes, usePages, useNode } from '@/hooks';
import type { Node as AppNode } from '@/types';

// ==================== Multi-Node Selector ====================

interface NodeSelectorProps {
  mode: 'types' | 'pages';
  selectedIds: number[];
  onAdd: (node: AppNode) => void;
  onRemove: (nodeId: number) => void;
  placeholder?: string;
  readOnly?: boolean;
}

export function NodeSelector({ mode, selectedIds, onAdd, onRemove, placeholder, readOnly }: NodeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const { data: types } = useTypes();
  const { data: pages } = usePages();
  
  const allNodes = useMemo(() => {
    if (mode === 'types') return types ?? [];
    return pages ?? [];
  }, [mode, types, pages]);
  
  const selectedNodes = useMemo(() => {
    return allNodes.filter(n => selectedIds.includes(n.id));
  }, [allNodes, selectedIds]);
  
  // Filter available (non-selected) nodes by search
  const filteredAvailable = useMemo(() => {
    const term = search.toLowerCase();
    return allNodes
      .filter(n => !selectedIds.includes(n.id))
      .filter(n => (n.name || '').toLowerCase().includes(term))
      .slice(0, 10);
  }, [allNodes, selectedIds, search]);
  
  // Total items for keyboard navigation (selected + available)
  const totalItems = selectedNodes.length + filteredAvailable.length;
  
  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredAvailable.length, search]);
  
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);
  
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);
  
  const handleToggle = useCallback((node: AppNode) => {
    if (selectedIds.includes(node.id)) {
      onRemove(node.id);
    } else {
      onAdd(node);
    }
  }, [selectedIds, onAdd, onRemove]);
  
  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, totalItems - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex < selectedNodes.length) {
          // Toggle off a selected item
          onRemove(selectedNodes[selectedIndex].id);
        } else {
          // Add an available item
          const availableIndex = selectedIndex - selectedNodes.length;
          if (availableIndex < filteredAvailable.length) {
            onAdd(filteredAvailable[availableIndex]);
          }
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        setSearch('');
        break;
    }
  }, [totalItems, selectedIndex, selectedNodes, filteredAvailable, onAdd, onRemove]);
  
  return (
    <div className="node-selector" ref={menuRef}>
      {/* Selected pills */}
      <div className="node-selector__pills">
        {selectedNodes.map(node => (
          <NodeTypePill
            key={node.id}
            typeNode={node}
            onRemove={readOnly ? undefined : () => onRemove(node.id)}
            readOnly={readOnly}
          />
        ))}
        
        {/* Add button / dropdown trigger */}
        {!readOnly && (
          <Button
            variant="ghost"
            size="xs"
            icon={mdiPlus}
            onClick={() => setIsOpen(!isOpen)}
            className="node-selector__add-btn"
          >
            {selectedIds.length === 0 ? (placeholder || 'Select...') : undefined}
          </Button>
        )}
      </div>
      
      {/* Dropdown with checkboxes */}
      {isOpen && (
        <Card
          variant="filled"
          padding={false}
          radius="md"
          elevation="high"
          className="node-selector__dropdown"
        >
          <div className="node-selector__search">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Search ${mode}...`}
              className="node-selector__input"
            />
          </div>
          <div className="node-selector__list">
            {/* Selected items section */}
            {selectedNodes.length > 0 && (
              <div className="node-selector__section node-selector__section--selected">
                <div className="node-selector__section-header">Selected</div>
                {selectedNodes.map((node, index) => (
                  <button
                    key={node.id}
                    type="button"
                    className={`node-selector__item ${index === selectedIndex ? 'node-selector__item--highlighted' : ''}`}
                    onClick={() => handleToggle(node)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <Checkbox checked={true} size="sm" readOnly className="node-selector__checkbox" />
                    <Icon path={mode === 'types' ? mdiTagOutline : mdiPageNextOutline} size={0.6} />
                    <span>{node.name || 'Untitled'}</span>
                  </button>
                ))}
              </div>
            )}
            
            {/* Available items section */}
            {filteredAvailable.length > 0 && (
              <div className="node-selector__section">
                {selectedNodes.length > 0 && (
                  <div className="node-selector__section-header">Available</div>
                )}
                {filteredAvailable.map((node, index) => {
                  const globalIndex = selectedNodes.length + index;
                  return (
                    <button
                      key={node.id}
                      type="button"
                      className={`node-selector__item ${globalIndex === selectedIndex ? 'node-selector__item--highlighted' : ''}`}
                      onClick={() => handleToggle(node)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                    >
                      <Checkbox checked={false} size="sm" readOnly className="node-selector__checkbox" />
                      <Icon path={mode === 'types' ? mdiTagOutline : mdiPageNextOutline} size={0.6} />
                      <span>{node.name || 'Untitled'}</span>
                    </button>
                  );
                })}
              </div>
            )}
            
            {/* Empty state */}
            {filteredAvailable.length === 0 && selectedNodes.length === 0 && (
              <div className="node-selector__empty">No {mode} found</div>
            )}
            {filteredAvailable.length === 0 && selectedNodes.length > 0 && search && (
              <div className="node-selector__section">
                <div className="node-selector__empty">No more {mode} found</div>
              </div>
            )}
          </div>
          <div className="node-selector__footer">
            <span className="node-selector__hint">Click to select/deselect</span>
          </div>
        </Card>
      )}
    </div>
  );
}

// ==================== Single Node Selector ====================

interface SingleNodeSelectorProps {
  mode: 'types' | 'pages';
  selectedId: number | null;
  onChange: (nodeId: number | null, node?: AppNode) => void;
  placeholder?: string;
  readOnly?: boolean;
}

export function SingleNodeSelector({ mode, selectedId, onChange, placeholder, readOnly }: SingleNodeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const { data: types } = useTypes();
  const { data: pages } = usePages();
  const { data: selectedNode } = useNode(selectedId);
  
  const allNodes = useMemo(() => {
    if (mode === 'types') return types ?? [];
    return pages ?? [];
  }, [mode, types, pages]);
  
  const filteredNodes = useMemo(() => {
    const term = search.toLowerCase();
    return allNodes
      .filter(n => (n.name || '').toLowerCase().includes(term))
      .slice(0, 10);
  }, [allNodes, search]);
  
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);
  
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);
  
  const handleSelect = useCallback((node: AppNode) => {
    onChange(node.id, node);
    setSearch('');
    setIsOpen(false);
  }, [onChange]);
  
  const handleClear = useCallback(() => {
    onChange(null);
  }, [onChange]);
  
  return (
    <div className="single-node-selector" ref={menuRef}>
      {selectedNode ? (
        <div className="single-node-selector__selected">
          <NodeTypePill
            typeNode={selectedNode}
            onRemove={readOnly ? undefined : handleClear}
            readOnly={readOnly}
          />
        </div>
      ) : (
        <Button
          variant="ghost"
          size="xs"
          icon={mdiChevronDown}
          iconPosition="right"
          onClick={() => !readOnly && setIsOpen(!isOpen)}
          disabled={readOnly}
          className="single-node-selector__trigger"
        >
          {placeholder || 'Select...'}
        </Button>
      )}
      
      {isOpen && (
        <Card
          variant="filled"
          padding={false}
          radius="md"
          elevation="high"
          className="single-node-selector__dropdown"
        >
          <div className="single-node-selector__search">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${mode}...`}
              className="single-node-selector__input"
            />
          </div>
          <div className="single-node-selector__list">
            {filteredNodes.length === 0 ? (
              <div className="single-node-selector__empty">No {mode} found</div>
            ) : (
              filteredNodes.map(node => (
                <button
                  key={node.id}
                  type="button"
                  className="single-node-selector__item"
                  onClick={() => handleSelect(node)}
                >
                  <Icon path={mode === 'types' ? mdiTagOutline : mdiPageNextOutline} size={0.6} />
                  <span>{node.name || 'Untitled'}</span>
                </button>
              ))
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
