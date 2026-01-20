/**
 * Archived pages view - displays all archived pages
 */
import { useArchivedPages, useUnarchiveNode } from '@/hooks';
import './ArchivedView.css';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import { NodeIcon, ArchiveIcon } from '../components/icons';

interface ArchivedPageItemProps {
  page: Node;
}

function ArchivedPageItem({ page }: ArchivedPageItemProps) {
  const { openNode } = useNodesStore();
  const unarchiveNode = useUnarchiveNode();
  
  const handleClick = () => {
    openNode(page.id, 'page');
  };
  
  const handleUnarchive = (e: React.MouseEvent) => {
    e.stopPropagation();
    unarchiveNode.mutate(page.id);
  };
  
  return (
    <div className="archived-page-item">
      <button 
        className="archived-page-content"
        onClick={handleClick}
      >
        <span className="archived-page-icon">
          <NodeIcon icon={page.icon} isPage={true} isDaily={page.is_daily} isMonthly={page.is_monthly} isYearly={page.is_yearly} />
        </span>
        <span className="archived-page-name">{page.name || 'Untitled'}</span>
      </button>
      <button 
        className="archived-page-action"
        onClick={handleUnarchive}
        title="Unarchive"
        disabled={unarchiveNode.isPending}
      >
        Unarchive
      </button>
    </div>
  );
}

export function ArchivedView() {
  const { data: archivedPages, isLoading, error } = useArchivedPages();
  
  if (isLoading) {
    return (
      <div className="archived-view">
        <div className="archived-view-loading">Loading archived pages...</div>
      </div>
    );
  }
  
  if (error) {
    return (
      <div className="archived-view">
        <div className="archived-view-error">Failed to load archived pages</div>
      </div>
    );
  }
  
  return (
    <div className="archived-view">
      <header className="archived-view-header">
        <ArchiveIcon size="lg" />
        <h1>Archived Pages</h1>
      </header>
      
      {(!archivedPages || archivedPages.length === 0) ? (
        <div className="archived-view-empty">
          <p>No archived pages</p>
          <p className="archived-view-hint">
            Archived pages will appear here. You can archive a page from its header.
          </p>
        </div>
      ) : (
        <div className="archived-page-list">
          {archivedPages.map((page) => (
            <ArchivedPageItem key={page.id} page={page} />
          ))}
        </div>
      )}
    </div>
  );
}
