/**
 * GraphGroupModal
 *
 * Modal for creating/editing graph color groups.
 * Wraps ViewBuilder (the query builder) with a color picker and name input.
 * Scope is always locked to 'pages'.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { ColorButton } from '@/components/core/ColorButton';
import type { ColorEntry } from '@/components/core/ColorButton';
import { TextField } from '@/components/core/TextField';
import { ViewBuilder } from '@/components/queries';
import type { QueryAST } from '@/types/queryAST';
import { createEmptyQueryAST } from '@/types/queryAST';
import { getQueryIntent } from '@/lib/astProseRenderer';
import type { GraphColorGroup } from './viewTypes';
import type { GraphNode as ApiGraphNode, GraphLink } from '@/api/nodes';
import type { Node } from '@/types';
import { evaluateQueryAST, buildEvalContext } from './evaluateQueryAST';
import type { Node as ApiNode } from '@/types/api';
import './GraphGroupModal.css';

// ==================== Types ====================

interface GraphGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (group: GraphColorGroup) => void;
  /** Existing group for editing, or null for new */
  initialGroup?: GraphColorGroup | null;
  /** Visible nodes for live match count */
  nodes: ApiGraphNode[];
  /** Links for live match count */
  links: GraphLink[];
  /** Classes for live match count */
  classes: Node[];
}

const COLOR_ENTRIES: ColorEntry[] = [
  { cssVar: '#c55a55', label: 'Red' },
  { cssVar: '#c98557', label: 'Orange' },
  { cssVar: '#b8a23a', label: 'Yellow' },
  { cssVar: '#4f8f6a', label: 'Green' },
  { cssVar: '#4a8a83', label: 'Teal' },
  { cssVar: '#5a79c9', label: 'Blue' },
  { cssVar: '#8a6cc9', label: 'Purple' },
  { cssVar: '#c06a9a', label: 'Pink' },
];

// ==================== Component ====================

export function GraphGroupModal({
  isOpen,
  onClose,
  onSave,
  initialGroup,
  nodes,
  links,
  classes,
}: GraphGroupModalProps) {
  const isEditing = !!initialGroup;

  const [name, setName] = useState('');
  const [query, setQuery] = useState<QueryAST>(createEmptyQueryAST());
  const [color, setColor] = useState(COLOR_ENTRIES[0].cssVar);

  // Reset state when opening for a new group; load existing data when editing
  useEffect(() => {
    if (isOpen) {
      setName(initialGroup?.name ?? '');
      setQuery(initialGroup?.query ?? createEmptyQueryAST());
      setColor(initialGroup?.color ?? COLOR_ENTRIES[0].cssVar);
    }
  }, [isOpen, initialGroup]);

  // Live match count
  const matchCount = useMemo(() => {
    if (!nodes.length) return 0;
    try {
      const ctx = buildEvalContext(nodes, links, classes);
      return nodes.filter(n => evaluateQueryAST(query, n, ctx)).length;
    } catch {
      return 0;
    }
  }, [query, nodes, links, classes]);

  const nodesMap = useMemo(() => {
    const map = new Map<string, ApiNode>();
    for (const n of nodes) {
      map.set(n.uuid, n as ApiNode);
    }
    for (const c of classes) {
      map.set(c.uuid, c as ApiNode);
    }
    return map;
  }, [nodes, classes]);

  const proseSummary = useMemo(() => {
    try {
      return getQueryIntent(query, nodesMap);
    } catch {
      return 'Invalid query';
    }
  }, [query, nodesMap]);

  const handleSave = useCallback(() => {
    if (!name.trim()) return;
    onSave({
      id: initialGroup?.id ?? generateId(),
      name: name.trim(),
      query,
      color,
    });
    onClose();
  }, [name, query, color, initialGroup, onSave, onClose]);

  const canSave = name.trim().length > 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? 'Edit Color Group' : 'New Color Group'}
      size="lg"
      contentClassName="graph-group-modal__content"
      footer={
        <div className="graph-group-modal__footer">
          <div className="graph-group-modal__match-count">
            {matchCount} node{matchCount !== 1 ? 's' : ''} match
          </div>
          <div className="graph-group-modal__actions">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={!canSave}>Save</Button>
          </div>
        </div>
      }
    >
      <div className="graph-group-modal__body">
        {/* Name */}
        <TextField
          label="Group name"
          placeholder="e.g. Important Books"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />

        {/* Color */}
        <div className="graph-group-modal__color-row">
          <span className="graph-group-modal__label">Color</span>
          <div className="graph-group-modal__color-palette">
            {COLOR_ENTRIES.map(({ cssVar, label }) => (
              <ColorButton
                key={cssVar}
                color={cssVar}
                size="xs"
                active={color === cssVar}
                onClick={() => setColor(cssVar)}
                title={label}
              />
            ))}
          </div>
        </div>

        {/* Query Builder */}
        <div className="graph-group-modal__query-section">
          <div className="graph-group-modal__query-header">
            <span className="graph-group-modal__label">Query</span>
            <span className="graph-group-modal__prose">{proseSummary}</span>
          </div>
          <div className="graph-group-modal__query-builder">
            <ViewBuilder
              ast={query}
              onChange={setQuery}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 9);
}
