/**
 * FilterBuilderModal — standalone query builder for temporary queries.
 *
 * Same building system as stored queries (ViewBuilder → QueryAST), but the
 * primary exit is "Run": opens the query as a temporary collection
 * (in-memory only, cleared on reload). "Save as view…" is the secondary
 * exit, promoting the AST to a stored page + query block.
 */
import { useEffect, useMemo, useState } from 'react';
import { useModalStore, useNavigationStore } from '@/stores';
import { useQueryCount } from '@/features/content/hooks/useNodeViews';
import { useSaveQueryAsView } from '@/features/queries';
import { createEmptyQueryAST } from '@/types/queryAST';
import type { QueryAST } from '@/types/queryAST';
import { ViewBuilder } from './ViewBuilder';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import './FilterBuilderModal.css';

export function FilterBuilderModal() {
  const isOpen = useModalStore((s) => s.isFilterBuilderOpen);
  const setOpen = useModalStore((s) => s.setFilterBuilderOpen);
  const openNodeCollection = useNavigationStore((s) => s.openNodeCollection);
  const { saveAsView, isSaving } = useSaveQueryAsView();

  const [ast, setAst] = useState<QueryAST>(createEmptyQueryAST);
  const [name, setName] = useState('');

  // Reset to a blank query every time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setAst(createEmptyQueryAST());
      setName('');
    }
  }, [isOpen]);

  const hasConditions = ast.root_group.children.length > 0;

  // Debounced live count ("N nodes found") while building.
  const [debouncedAst, setDebouncedAst] = useState<QueryAST | null>(null);
  useEffect(() => {
    if (!hasConditions) {
      setDebouncedAst(null);
      return;
    }
    const handle = setTimeout(() => setDebouncedAst(ast), 300);
    return () => clearTimeout(handle);
  }, [ast, hasConditions]);

  const { data: matchCount } = useQueryCount(
    { query_ast: debouncedAst ?? createEmptyQueryAST() },
    { enabled: isOpen && !!debouncedAst },
  );

  const close = () => setOpen(false);

  const handleRun = () => {
    if (!hasConditions) return;
    openNodeCollection(name.trim() || 'Temporary query', ast);
    close();
  };

  const handleSave = () => {
    if (!hasConditions || !name.trim()) return;
    saveAsView(name, ast)
      .then(() => close())
      .catch(() => { /* error already notified in the hook; keep the modal open */ });
  };

  const footer = useMemo(
    () => (
      <>
        <span className="filter-builder__count" aria-live="polite">
          {debouncedAst && matchCount !== undefined
            ? `${matchCount} node${matchCount !== 1 ? 's' : ''} found`
            : ''}
        </span>
        <Button variant="ghost" size="sm" onClick={close}>
          Cancel
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="mdi mdi-content-save-outline"
          onClick={handleSave}
          disabled={isSaving || !hasConditions || !name.trim()}
          title={!name.trim() ? 'Name the view to save it' : 'Save as view'}
        >
          Save as view…
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon="mdi mdi-play-outline"
          onClick={handleRun}
          disabled={!hasConditions}
          title={!hasConditions ? 'Add at least one condition to run' : 'Run as temporary query'}
        >
          Run
        </Button>
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debouncedAst, matchCount, hasConditions, name, isSaving],
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title="New temporary query"
      footer={footer}
    >
      <div className="filter-builder">
        <TextField
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional — required to save)"
          aria-label="Query name"
          size="sm"
        />
        <ViewBuilder ast={ast} onChange={setAst} hideFooter />
        <p className="filter-builder__hint">
          Run opens a temporary view that is cleared on reload. Save keeps it as a page.
        </p>
      </div>
    </Modal>
  );
}
