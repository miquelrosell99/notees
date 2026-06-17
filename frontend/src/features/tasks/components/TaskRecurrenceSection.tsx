/**
 * TaskRecurrenceSection — recurrence rule editor + completion history for tasks.
 *
 * Rendered inside NodeView for any node that has the task flag. It lives next
 * to the standard PropertiesSection so the legacy task_recurrence property
 * (kept for QueryAST filters) is no longer the only UI for recurrence.
 */
// Kept as a deep import to avoid a circular dependency: the content barrel
// exports NodeView, which renders TaskRecurrenceSection. If this component
// imported the content barrel, we would get tasks -> content -> tasks.
import { NodeViewSection } from '@/features/content/components/nodes/NodeViewSection';
import { useDeleteTaskRecurrence, useSetTaskRecurrence, useTaskRecurrence } from '@/hooks';
import { useNotifications } from '@/stores/notificationStore';
import type { RecurrenceRuleInput } from '@/types/api';
import { TaskCompletionHistory } from './TaskCompletionHistory';
import { TaskRecurrencePicker } from './TaskRecurrencePicker';
import './TaskRecurrenceSection.css';

interface TaskRecurrenceSectionProps {
  nodeId: number;
  readOnly?: boolean;
}

export function TaskRecurrenceSection({ nodeId, readOnly = false }: TaskRecurrenceSectionProps) {
  const { data: rule } = useTaskRecurrence(nodeId);
  const setMutation = useSetTaskRecurrence();
  const deleteMutation = useDeleteTaskRecurrence();
  const { error: notifyError } = useNotifications();

  const handleChange = (input: RecurrenceRuleInput) => {
    setMutation.mutate(
      { nodeId, rule: input },
      {
        onError: () => notifyError('Failed to save recurrence rule', 'Please try again.'),
      }
    );
  };

  const handleDelete = () => {
    deleteMutation.mutate(
      { nodeId },
      {
        onError: () => notifyError('Failed to remove recurrence rule', 'Please try again.'),
      }
    );
  };

  return (
    <NodeViewSection
      title="Recurrence"
      icon={<span className="task-recurrence-section__icon mdi mdi-repeat" aria-hidden="true" />}
      className="task-recurrence-section"
      defaultExpanded={true}
      hideWhenEmpty={false}
    >
      <div className="task-recurrence-section__body">
        <TaskRecurrencePicker
          rule={rule ?? null}
          onChange={handleChange}
          onDelete={rule ? handleDelete : undefined}
          readOnly={readOnly || setMutation.isPending || deleteMutation.isPending}
        />
        <TaskCompletionHistory nodeId={nodeId} readOnly={readOnly} />
      </div>
    </NodeViewSection>
  );
}
