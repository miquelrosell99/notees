/**
 * CardBreadcrumbs — Compact ancestor breadcrumbs for card view.
 *
 * Shows faint, clickable parent ancestors for pages that have parents,
 * and the containing page for blocks. Very compact to fit inside cards.
 */
import { memo, useMemo } from 'react';
import { useBreadcrumbs } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useNavigationStore } from '@/stores';
import type { Node } from '@/types';
import './CardBreadcrumbs.css';

interface CardBreadcrumbsProps {
  node: Node;
}

export const CardBreadcrumbs = memo(function CardBreadcrumbs({
  node,
}: CardBreadcrumbsProps) {
  const { data: breadcrumbs, isPending } = useBreadcrumbs(
    node.is_page && node.parent_id ? node.id : null
  );
  const { openNode } = useNavigationStore();

  const items = useMemo(() => {
    if (node.is_page) {
      if (!breadcrumbs || breadcrumbs.length === 0) return [];
      return breadcrumbs.map((b) => ({
        id: b.id,
        name: nodeNameToText(b.display_name || b.name) || 'Untitled',
      }));
    }

    // Block: show containing page
    if (!node.page_id) return [];
    return [
      {
        id: node.page_id,
        name: node.page_name || 'Untitled',
      },
    ];
  }, [node, breadcrumbs]);

  if (isPending || items.length === 0) return null;

  return (
    <span className="card-breadcrumbs">
      {items.map((item, index) => (
        <span key={item.id} className="card-breadcrumbs__segment">
          <button
            className="card-breadcrumbs__link"
            onClick={(e) => {
              e.stopPropagation();
              openNode(item.id);
            }}
            title={`Open ${item.name}`}
            type="button"
          >
            {item.name}
          </button>
          {index < items.length - 1 && (
            <span className="card-breadcrumbs__separator">›</span>
          )}
        </span>
      ))}
    </span>
  );
});
