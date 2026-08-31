/**
 * ClassConsolidationSection Component
 *
 * Minimal UI entry for the opt-in class consolidation tool (Decision 26).
 * The user picks an explicit old→new class pair; equivalence is never
 * guessed from names. Rendered inside GraphSettingsModal.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/Button';
import { Dropdown } from '@/components/ui/Dropdown';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { consolidateClass, listWorkspaceClasses } from '../api/workspaces';
import type { ClassConsolidationResult } from '../api/workspaces';
import { validateConsolidationMapping } from '../utils/classConsolidation';

const CLASSES_QUERY_KEY = 'workspace-classes';

export function ClassConsolidationSection() {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const queryClient = useQueryClient();
  const [oldClassUuid, setOldClassUuid] = useState<string | null>(null);
  const [newClassUuid, setNewClassUuid] = useState<string | null>(null);
  const [summary, setSummary] = useState<ClassConsolidationResult | null>(null);

  const classesQuery = useQuery({
    queryKey: [CLASSES_QUERY_KEY, workspaceUuid ?? 'none'],
    queryFn: () => listWorkspaceClasses(workspaceUuid!),
    enabled: !!workspaceUuid,
  });

  const mutation = useMutation({
    mutationFn: ({ oldUuid, newUuid }: { oldUuid: string; newUuid: string }) =>
      consolidateClass(workspaceUuid!, oldUuid, newUuid),
    onSuccess: (result) => {
      setSummary(result);
      setOldClassUuid(null);
      queryClient.invalidateQueries({ queryKey: [CLASSES_QUERY_KEY, workspaceUuid ?? 'none'] });
    },
  });

  const classes = classesQuery.data ?? [];
  const options = classes.map((c) => ({
    value: c.id,
    label: c.is_system ? `${c.name} (system)` : c.name,
  }));
  const validationError = validateConsolidationMapping(oldClassUuid, newClassUuid);

  return (
    <div className="settings-section">
      <h3 className="settings-section__title settings-section__title--spaced">Class Consolidation</h3>
      <p className="settings-item__description">
        Merge a class you created into another class (e.g. a system class): nodes are
        re-classed, matching property bindings are remapped, and the old class is removed.
        The mapping is always explicit — nothing is guessed from names.
      </p>
      <div className="settings-item">
        <div className="settings-item__info">
          <label htmlFor="consolidate-old-class" className="settings-item__label">Class to consolidate</label>
        </div>
        <Dropdown
          id="consolidate-old-class"
          options={options}
          value={oldClassUuid}
          onChange={(value) => {
            setOldClassUuid(value);
            setSummary(null);
          }}
          size="sm"
          placeholder="Select class…"
        />
      </div>
      <div className="settings-item">
        <div className="settings-item__info">
          <label htmlFor="consolidate-new-class" className="settings-item__label">Into class</label>
        </div>
        <Dropdown
          id="consolidate-new-class"
          options={options}
          value={newClassUuid}
          onChange={(value) => {
            setNewClassUuid(value);
            setSummary(null);
          }}
          size="sm"
          placeholder="Select target class…"
        />
      </div>
      <div className="settings-item">
        <Button
          variant="default"
          size="sm"
          disabled={validationError !== null || mutation.isPending}
          onClick={() => {
            if (oldClassUuid && newClassUuid) {
              mutation.mutate({ oldUuid: oldClassUuid, newUuid: newClassUuid });
            }
          }}
        >
          {mutation.isPending ? 'Consolidating…' : 'Consolidate'}
        </Button>
      </div>
      {mutation.isError && (
        <p className="settings-item__description" role="alert">
          Consolidation failed:{' '}
          {mutation.error instanceof Error ? mutation.error.message : 'unknown error'}
        </p>
      )}
      {summary && (
        <p className="settings-item__description" role="status">
          Consolidated “{summary.old_class_name}” into “{summary.new_class_name}”:{' '}
          {summary.nodes_reassigned} node(s) reassigned,{' '}
          {summary.property_edges_remapped} property binding(s) remapped,{' '}
          {summary.property_values_migrated} value(s) migrated.
        </p>
      )}
    </div>
  );
}
