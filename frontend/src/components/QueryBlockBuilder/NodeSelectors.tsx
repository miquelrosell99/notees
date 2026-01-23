/**
 * Node Selector Components
 * 
 * Components for selecting nodes (types, pages) in the query builder.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  mdiPlus,
  mdiChevronDown,
  mdiTagOutline,
  mdiPageNextOutline,
} from '@mdi/js';
import Icon from '@mdi/react';
import { Card } from '../core/Card';
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
  
  const filteredNodes = useMemo(() => {
    const term = search.toLowerCase();
    return allNodes
      .filter(n => !selectedIds.includes(n.id))
      .filter(n => (n.name || '').toLowerCase().includes(term))
      .slice(0, 10);
  }, [allNodes, selectedIds, search]);
  
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
  
  const handleSelect = (node: AppNode) => {
    onAdd(node);
    setSearch('');
    setIsOpen(false);
  };
  
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
          <button
            type="button"
            className="node-selector__add-btn"
            onClick={() => setIsOpen(!isOpen)}
          >
            <Icon path={mdiPlus} size={0.6} />
            {selectedIds.length === 0 && <span>{placeholder || 'Select...'}</span>}
          </button>
        )}
      </div>
      
      {/* Dropdown */}
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
              placeholder={`Search ${mode}...`}
              className="node-selector__input"
            />
          </div>
          <div className="node-selector__list">
            {filteredNodes.length === 0 ? (
              <div className="node-selector__empty">No {mode} found</div>
            ) : (
              filteredNodes.map(node => (
                <button
                  key={node.id}
                  type="button"
                  className="node-selector__item"
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
        <button
          type="button"
          className="single-node-selector__trigger"
          onClick={() => !readOnly && setIsOpen(!isOpen)}
          disabled={readOnly}
        >
          <span className="single-node-selector__placeholder">{placeholder || 'Select...'}</span>
          <Icon path={mdiChevronDown} size={0.6} />
        </button>
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
