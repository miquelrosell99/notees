import type React from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { InlineConfirmButton } from '@/components/ui/InlineConfirmButton';
import { TextField } from '@/components/ui/TextField';
import { Spinner } from '@/components/ui/Spinner';
import { ViewBuilder } from '@/features/queries';
import { ProseScopeSelector } from '@/features/queries';
import { DeleteIcon } from '@/components/ui/icons';
import { canSaveQuery } from '@/lib/queryValidation';
import type { NodeView } from '@/types/nodeView';
import type { QueryAST, ValidationResult } from '@/types/queryAST';
import type { Node } from '@/types';

export interface QueryEditModalProps {
  editingView: NodeView | null;
  editAST: QueryAST | null;
  editViewName: string;
  validation: ValidationResult | null;
  viewType: string;
  previewResults?: Node[];
  previewLoading: boolean;
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
  onASTChange: (ast: QueryAST) => void;
  onViewNameChange: (name: string) => void;
  onResetViews: () => void | Promise<void>;
  onShowProse: () => void;
}

export const QueryEditModal: React.FC<QueryEditModalProps> = ({
  editingView,
  editAST,
  editViewName,
  validation,
  viewType,
  previewResults,
  previewLoading,
  onClose,
  onSave,
  onDelete,
  onASTChange,
  onViewNameChange,
  onResetViews,
  onShowProse,
}) => {
  const scopeReadOnly = ['linked_references', 'child_pages', 'classed_nodes', 'extended_by'].includes(viewType);

  return (
    <Modal
      isOpen={!!editingView}
      onClose={onClose}
      title="Query"
      headerLeftElement={
        <Button
          aria-label="Show query as prose"
          icon="mdi mdi-eye-outline"
          variant="ghost"
          size="xs"
          onClick={onShowProse}
          title="Show query as prose"
        />
      }
      size="xl"
      className="query-section__edit-modal"
      footer={editingView && (
        <div className="query-section__modal-footer">
          <div className="view-builder__footer-left">
            <ProseScopeSelector
              scope={editAST?.scope || { type: 'scope', scope_type: 'current_page' }}
              onChange={(newScope) => {
                if (editAST) {
                  onASTChange({
                    ...editAST,
                    scope: newScope,
                  });
                }
              }}
              readOnly={scopeReadOnly}
            />
          </div>

          {previewResults && (
            <div className="view-builder__result-preview">
              {previewLoading ? (
                <span className="view-builder__result-loading"><Spinner size="sm" label="Calculating…" /></span>
              ) : (
                <span className="view-builder__result-count">
                  <span className="view-builder__result-dot">●</span>
                  {previewResults.length} node{previewResults.length !== 1 ? 's' : ''} found
                </span>
              )}
            </div>
          )}

          <div className="query-section__footer-spacer" />

          <Button
            aria-label="Reset all views to defaults"
            icon="mdi mdi-restore"
            variant="ghost"
            size="sm"
            title="Reset all views to defaults"
            onClick={onResetViews}
          />

          <TextField
            value={editViewName}
            onChange={(e) => onViewNameChange(e.target.value)}
            placeholder="View name"
            size="sm"
            className="query-section__view-name-field"
          />

          {!editingView.is_default && (
            <InlineConfirmButton
              variant="ghost"
              size="sm"
              title="Delete view"
              onConfirm={onDelete}
            >
              <DeleteIcon size="sm" />
            </InlineConfirmButton>
          )}

          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            disabled={validation ? !canSaveQuery(validation) : false}
          >
            Save
          </Button>
        </div>
      )}
    >
      {editingView && editAST && (
        <div className="query-section__edit-content">
          <ViewBuilder
            ast={editAST}
            onChange={onASTChange}
            resultCount={previewResults?.length ?? 0}
            isLoading={previewLoading}
          />
        </div>
      )}
    </Modal>
  );
};
