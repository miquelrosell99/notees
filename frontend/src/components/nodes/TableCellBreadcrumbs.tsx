/**
 * TableCellBreadcrumbs — Compact ancestor breadcrumbs for table name cells.
 *
 * Shows faint, clickable parent ancestors for pages that have parents.
 * Fetches the full breadcrumb chain via useBreadcrumbs (batched/cached).
 */
import { useMemo, memo } from 'react';
import { useBreadcrumbs } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useNavigationStore } from '@/stores';
import type { Node } from '@/types';
import './TableCellBreadcrumbs.css';

interface TableCellBreadcrumbsProps {
  node: Node;
}

export const TableCellBreadcrumbs = memo(function TableCellBreadcrumbs({
  node,
}: TableCellBreadcrumbsProps) {
  const { data: breadcrumbs, isPending } = useBreadcrumbs(
    node.is_page && node.parent_id ? node.id : null
  );
  const { openNode } = useNavigationStore();

  const items = useMemo(() => {
    if (!breadcrumbs || breadcrumbs.length === 0) return [];
    // breadcrumbs are root → immediate parent; we show all of them
    return breadcrumbs.map((b) => ({
      id: b.id,
      name: nodeNameToText(b.display_name || b.name) || 'Untitled',
    }));
  }, [breadcrumbs]);

  if (!node.is_page || !node.parent_id) return null;
  if (isPending || items.length === 0) return null;

  return (
    <span className="table-cell-breadcrumbs">
      {items.map((item) => (
        <span key={item.id} className="table-cell-breadcrumbs__segment">
          <button
            className="table-cell-breadcrumbs__link"
            onClick={(e) => {
              e.stopPropagation();
              openNode(item.id);
            }}
            title={`Open ${item.name}`}
          >
            {item.name}
          </button>
          <span className="table-cell-breadcrumbs__separator">›</span>
        </span>
      ))}
    </span>
  );
});
