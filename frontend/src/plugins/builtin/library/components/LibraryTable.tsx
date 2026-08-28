/**
 * LibraryTable — tabular rendering of Library sources.
 *
 * Flat mode renders every source as its own row; grouped mode renders Works
 * with their Editions collapsed beneath them (expandable per work).
 */
import React, { useState, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import type { Node } from '@/types';
import {
  libraryNodeName,
  readTextProperty,
  resolveAuthorNames,
  type WorkGroup,
} from '../libraryUtils';

interface LibraryTableProps {
  /** Flat mode: every source its own row. */
  rows: Node[];
  /** Grouped mode: works with editions collapsed beneath them. */
  groups: WorkGroup[];
  grouped: boolean;
  /** uuid → display name for class pills. */
  classNamesByUuid: ReadonlyMap<string, string>;
  agentsByUuid: ReadonlyMap<string, Node>;
  onOpenNode: (nodeUuid: string) => void;
  /** Three-pane mode: row click selects (inspector) instead of navigating. */
  onSelectNode?: (nodeUuid: string) => void;
  /** Currently selected row (inspector target). */
  selectedUuid?: string | null;
}

export function LibraryTable({
  rows,
  groups,
  grouped,
  classNamesByUuid,
  agentsByUuid,
  onOpenNode,
  onSelectNode,
  selectedUuid,
}: LibraryTableProps) {
  const [expandedWorks, setExpandedWorks] = useState<ReadonlySet<string>>(new Set());

  const toggleWork = useCallback((workUuid: string) => {
    setExpandedWorks((prev) => {
      const next = new Set(prev);
      if (next.has(workUuid)) {
        next.delete(workUuid);
      } else {
        next.add(workUuid);
      }
      return next;
    });
  }, []);

  const renderRow = (node: Node, opts: { isEdition?: boolean; editions?: Node[] } = {}): React.ReactNode => {
    const { isEdition = false, editions = [] } = opts;
    const isExpanded = expandedWorks.has(node.uuid);
    const isSelected = selectedUuid === node.uuid;
    const classLabels = (node.classes_uuid ?? [])
      .map((uuid) => classNamesByUuid.get(uuid))
      .filter((name): name is string => !!name);
    const authors = resolveAuthorNames(node, agentsByUuid);

    return [
      <tr
        key={node.uuid}
        className={`library-table__row${isEdition ? ' library-table__row--edition' : ''}${isSelected ? ' library-table__row--selected' : ''}`}
        onClick={() => (onSelectNode ?? onOpenNode)(node.uuid)}
        aria-selected={isSelected || undefined}
      >
        <td className="library-table__cell library-table__cell--title">
          {grouped && !isEdition && editions.length > 0 ? (
            <Button
              variant="ghost"
              size="xs"
              icon={isExpanded ? 'mdi mdi-chevron-down' : 'mdi mdi-chevron-right'}
              className="library-table__expand-btn"
              onClick={(e) => {
                e.stopPropagation();
                toggleWork(node.uuid);
              }}
              aria-label={isExpanded ? 'Collapse editions' : 'Expand editions'}
              aria-expanded={isExpanded}
              title={`${editions.length} edition${editions.length === 1 ? '' : 's'}`}
            />
          ) : (
            <span className="library-table__expand-spacer" aria-hidden="true" />
          )}
          <span className="library-table__title">{libraryNodeName(node)}</span>
          {grouped && !isEdition && editions.length > 0 && (
            <span className="library-table__edition-count">
              {editions.length} edition{editions.length === 1 ? '' : 's'}
            </span>
          )}
        </td>
        <td className="library-table__cell library-table__cell--classes">
          {classLabels.map((name) => (
            <span key={name} className="library-table__class-pill">
              {name}
            </span>
          ))}
        </td>
        <td className="library-table__cell">{authors.join(', ')}</td>
        <td className="library-table__cell">
          {readTextProperty(node, SYSTEM_PROPERTY_UUIDS.publication_date)}
        </td>
        <td className="library-table__cell library-table__cell--citekey">
          {readTextProperty(node, SYSTEM_PROPERTY_UUIDS.citekey)}
        </td>
      </tr>,
      ...(isExpanded
        ? editions.map((edition) => renderRow(edition, { isEdition: true }))
        : []),
    ];
  };

  return (
    <table className="library-table">
      <thead>
        <tr>
          <th className="library-table__heading">Title</th>
          <th className="library-table__heading">Class</th>
          <th className="library-table__heading">Authors</th>
          <th className="library-table__heading">Published</th>
          <th className="library-table__heading">Citekey</th>
        </tr>
      </thead>
      <tbody>
        {grouped
          ? groups.map((group) => renderRow(group.work, { editions: group.editions }))
          : rows.map((node) => renderRow(node))}
      </tbody>
    </table>
  );
}
