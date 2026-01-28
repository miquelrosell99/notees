/**
 * Archived Pages View
 * 
 * Displays pages that have been archived (active = false).
 * Archiving is different from deletion - archived pages are hidden from
 * normal views but can be unarchived and restored.
 */
import { useState } from 'react';
import { useArchivedPages, useUnarchiveNode } from '@/hooks';
import { Button } from '@/components/core';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import Icon from '@mdi/react';
import * as mdiIcons from '@mdi/js';
import './ArchivedPagesView.css';

export function ArchivedPagesView() {
  const { data: response, isLoading } = useArchivedPages();
  const unarchiveMutation = useUnarchiveNode();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const pages = response?.pages || [];

  const toggleSelection = (id: number) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const toggleAll = () => {
    if (selectedIds.size === pages.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pages.map(p => p.id)));
    }
  };

  const handleUnarchive = async (id: number) => {
    await unarchiveMutation.mutateAsync(id);
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleBulkUnarchive = async () => {
    for (const id of selectedIds) {
      await unarchiveMutation.mutateAsync(id);
    }
    setSelectedIds(new Set());
  };

  if (isLoading) {
    return (
      <div className="archived-pages-view">
        <div className="archived-header">
          <h1>📦 Archived Pages</h1>
        </div>
        <div className="archived-empty">Loading...</div>
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div className="archived-pages-view">
        <div className="archived-header">
          <h1>📦 Archived Pages</h1>
        </div>
        <div className="archived-empty">
          <p>No archived pages</p>
          <p className="archived-empty-hint">
            Archived pages are hidden from normal views but not deleted.
            You can archive a page from its context menu.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="archived-pages-view">
      <div className="archived-header">
        <h1>📦 Archived Pages</h1>
        <div className="archived-actions">
          {selectedIds.size > 0 && (
            <Button 
              onClick={handleBulkUnarchive}
              variant="primary"
              disabled={unarchiveMutation.isPending}
            >
              Unarchive {selectedIds.size} page{selectedIds.size > 1 ? 's' : ''}
            </Button>
          )}
        </div>
      </div>

      <div className="archived-list">
        <div className="archived-list-header">
          <label className="archived-checkbox">
            <input
              type="checkbox"
              checked={selectedIds.size === pages.length && pages.length > 0}
              onChange={toggleAll}
            />
          </label>
          <div className="archived-list-columns">
            <div className="archived-col-name">Name</div>
            <div className="archived-col-archived">Archived</div>
            <div className="archived-col-actions">Actions</div>
          </div>
        </div>

        {pages.map((page) => {
          const icon = getEffectiveIcon(page);
          const mdiPath = icon ? (mdiIcons as any)[icon] : null;

          return (
            <div 
              key={page.id} 
              className={`archived-item ${selectedIds.has(page.id) ? 'selected' : ''}`}
            >
              <label className="archived-checkbox">
                <input
                  type="checkbox"
                  checked={selectedIds.has(page.id)}
                  onChange={() => toggleSelection(page.id)}
                />
              </label>
              
              <div className="archived-item-content">
                <div className="archived-col-name">
                  <div className="archived-item-icon">
                    {mdiPath && <Icon path={mdiPath} size={0.9} />}
                  </div>
                  <span className="archived-item-name">{page.name}</span>
                </div>

                <div className="archived-col-archived">
                  {page.write_date ? new Date(page.write_date).toLocaleDateString() : '-'}
                </div>

                <div className="archived-col-actions">
                  <Button
                    onClick={() => handleUnarchive(page.id)}
                    size="sm"
                    variant="secondary"
                    disabled={unarchiveMutation.isPending}
                  >
                    Unarchive
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
