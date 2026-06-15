/**
 * TaskCompletionHistory — read-only list of past completions for a recurring task.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Icon } from '@/components/ui/icons';
import { useDeleteTaskCompletion, useTaskCompletions } from '@/hooks';
import { formatDate } from '@/stores';
import { useSettingsStore } from '@/stores';
import type { TaskCompletion } from '@/types/api';
import './TaskCompletionHistory.css';

interface TaskCompletionHistoryProps {
  nodeId: number;
  readOnly?: boolean;
}

const STATUS_ICONS: Record<TaskCompletion['status'], string> = {
  done: 'mdi mdi-check-circle',
  cancelled: 'mdi mdi-close-circle',
  skipped: 'mdi mdi-skip-forward',
};

const STATUS_LABELS: Record<TaskCompletion['status'], string> = {
  done: 'Done',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

export function TaskCompletionHistory({ nodeId, readOnly = false }: TaskCompletionHistoryProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { data: completions, isLoading } = useTaskCompletions(nodeId, { limit: 50 });
  const { deleteCompletion, isPending: isDeleting } = useDeleteTaskCompletion();
  const dateFormat = useSettingsStore((state) => state.dateFormat);

  const count = completions?.length ?? 0;

  return (
    <div className="task-completion-history">
      <button
        type="button"
        className="task-completion-history__trigger"
        onClick={() => setIsOpen(true)}
        aria-label={`View completion history (${count} entries)`}
      >
        <span className="task-completion-history__icon mdi mdi-history" aria-hidden="true" />
        <span className="task-completion-history__count">{count}</span>
        <span className="task-completion-history__label">completion{count === 1 ? '' : 's'}</span>
      </button>

      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Completion history"
        size="sm"
      >
        {isLoading ? (
          <div className="task-completion-history__loading">Loading…</div>
        ) : !completions || completions.length === 0 ? (
          <EmptyState
            icon={<Icon path="mdi mdi-history" size={1.2} />}
            title="No completions yet"
            description="This task has not been completed or skipped."
          />
        ) : (
          <ul className="task-completion-history__list">
            {completions.map((completion) => (
              <li key={completion.id} className="task-completion-history__item">
                <span className={`task-completion-history__status ${`task-completion-history__status--${completion.status}`}`}>
                  <span className={`mdi ${STATUS_ICONS[completion.status]}`} aria-hidden="true" />
                  <span>{STATUS_LABELS[completion.status]}</span>
                </span>
                <span className="task-completion-history__dates">
                  {completion.scheduled_date && (
                    <span title="Scheduled">
                      {formatDate(new Date(completion.scheduled_date), dateFormat)}
                    </span>
                  )}
                  {completion.deadline_date && (
                    <span title="Deadline">
                      {formatDate(new Date(completion.deadline_date), dateFormat)}
                    </span>
                  )}
                </span>
                <span className="task-completion-history__completed-at">
                  {formatDate(new Date(completion.completed_at), dateFormat)}
                </span>
                {!readOnly && (
                  <Button
                    icon="mdi mdi-delete"
                    aria-label="Delete completion record"
                    size="xs"
                    variant="ghost"
                    disabled={isDeleting}
                    onClick={() => deleteCompletion(nodeId, completion.id)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}
