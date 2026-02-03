/**
 * Node Selector Components
 * 
 * Components for selecting nodes (types, pages) in the query builder.
 * Uses the standard SearchBox component for consistent UX.
 */
import { useCallback, useMemo } from 'react';
import { mdiTagOutline, mdiPageNextOutline } from '@mdi/js';
import Icon from '@mdi/react';
import { NodeClassPill } from '../NodeClassPill';
import { SearchBox } from '../SearchBox';
import { useClasses, usePages, useNode } from '@/hooks';
import type { Node as AppNode } from '@/types';

// ==================== Multi-Node Selector ====================

interface NodeSelectorProps {
  mode: 'classes' | 'pages';
  selectedIds: number[];
  onAdd: (node: AppNode) => void;
  onRemove: (nodeId: number) => void;
  placeholder?: string;
  readOnly?: boolean;
}

export function NodeSelector({ mode, selectedIds, onAdd, onRemove, placeholder, readOnly }: NodeSelectorProps) {
  const { data: classes } = useClasses();
  const { data: pages } = usePages();
  
  const allNodes = useMemo(() => {
    if (mode === 'classes') return classes ?? [];
    return pages ?? [];
  }, [mode, classes, pages]);
  
  const selectedNodes = useMemo(() => {
    const selectedSet = new Set(selectedIds);
    return allNodes.filter(n => selectedSet.has(n.id));
  }, [allNodes, selectedIds]);
  
  const handleSelect = useCallback((node: AppNode) => {
    if (!selectedIds.includes(node.id)) {
      onAdd(node);
    }
  }, [selectedIds, onAdd]);
  
  const handleRemove = useCallback((nodeId: number) => {
    onRemove(nodeId);
  }, [onRemove]);
  
  // Custom search function that filters out already selected nodes
  const searchFn = useCallback(async (query: string) => {
    const term = query.toLowerCase();
    const selectedSet = new Set(selectedIds);
    return allNodes
      .filter(n => !selectedSet.has(n.id))
      .filter(n => (n.name || '').toLowerCase().includes(term))
      .slice(0, 10);
  }, [allNodes, selectedIds]);
  
  return (
    <div className="node-selector">
      {/* Selected items */}
      {selectedNodes.length > 0 && (
        <div className="node-selector__selected">
          {selectedNodes.map(node => (
            <NodeClassPill
              key={node.id}
              classNode={node}
              onRemove={readOnly ? undefined : () => handleRemove(node.id)}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
      
      {/* Search box */}
      {!readOnly && (
        <SearchBox
          placeholder={placeholder || `Search ${mode}...`}
          searchFn={searchFn}
          onSelect={handleSelect}
          renderItem={(node) => (
            <>
              <span className="result-icon">
                <Icon path={mode === 'classes' ? mdiTagOutline : mdiPageNextOutline} size={0.6} />
              </span>
              <span className="result-title">
                {node.name || 'Untitled'}
              </span>
            </>
          )}
        />
      )}
    </div>
  );
}

// ==================== Single Node Selector ====================

interface SingleNodeSelectorProps {
  mode: 'classes' | 'pages';
  selectedId: number | null;
  onChange: (nodeId: number | null, node?: AppNode) => void;
  placeholder?: string;
  readOnly?: boolean;
  showCurrentPageOption?: boolean;
}

export function SingleNodeSelector({ mode, selectedId, onChange, placeholder, readOnly, showCurrentPageOption = false }: SingleNodeSelectorProps) {
  const { data: classes } = useClasses();
  const { data: pages } = usePages();
  // Don't fetch node if selectedId is -1 (Current Page special value)
  const { data: selectedNode } = useNode(selectedId && selectedId !== -1 ? selectedId : null);
  
  const allNodes = useMemo(() => {
    if (mode === 'classes') return classes ?? [];
    return pages ?? [];
  }, [mode, classes, pages]);
  
  // Check if "Current Page" is selected (special value -1)
  const isCurrentPageSelected = selectedId === -1;
  
  const handleSelect = useCallback((node: AppNode | 'current-page') => {
    if (node === 'current-page') {
      onChange(-1);
    } else {
      onChange(node.id, node);
    }
  }, [onChange]);
  
  const handleClear = useCallback(() => {
    onChange(null);
  }, [onChange]);
  
  // Custom search function
  const searchFn = useCallback(async (query: string) => {
    const term = query.toLowerCase();
    return allNodes
      .filter(n => (n.name || '').toLowerCase().includes(term))
      .slice(0, 10);
  }, [allNodes]);
  
  // Build sections array with "Current Page" option if enabled
  const sections = useMemo(() => {
    const sectionsList = [];
    
    if (showCurrentPageOption) {
      sectionsList.push({
        title: 'Special',
        searchFn: async () => [{ id: -1, name: 'Current Page', is_page: true } as AppNode],
        renderItem: () => (
          <>
            <span className="result-icon">
              <Icon path={mdiPageNextOutline} size={0.6} />
            </span>
            <span className="result-title">Current Page</span>
          </>
        ),
      });
    }
    
    sectionsList.push({
      searchFn,
      renderItem: (node: AppNode) => (
        <>
          <span className="result-icon">
            <Icon path={mode === 'classes' ? mdiTagOutline : mdiPageNextOutline} size={0.6} />
          </span>
          <span className="result-title">
            {node.name || 'Untitled'}
          </span>
        </>
      ),
    });
    
    return sectionsList;
  }, [showCurrentPageOption, searchFn, mode]);
  
  return (
    <div className="single-node-selector">
      {isCurrentPageSelected ? (
        <div className="single-node-selector__selected">
          <div className="node-class-pill node-class-pill--readonly">
            <span className="node-class-pill__content">Current Page</span>
            {!readOnly && (
              <button
                type="button"
                className="node-class-pill__remove"
                onClick={handleClear}
                aria-label="Remove"
              >
                ×
              </button>
            )}
          </div>
        </div>
      ) : selectedNode ? (
        <div className="single-node-selector__selected">
          <NodeClassPill
            classNode={selectedNode}
            onRemove={readOnly ? undefined : handleClear}
            readOnly={readOnly}
          />
        </div>
      ) : !readOnly ? (
        <SearchBox
          placeholder={placeholder || 'Select...'}
          sections={sections}
          onSelect={(node) => handleSelect(typeof node === 'string' ? node : node)}
        />
      ) : (
        <div className="single-node-selector__empty">
          {placeholder || 'None selected'}
        </div>
      )}
    </div>
  );
}

