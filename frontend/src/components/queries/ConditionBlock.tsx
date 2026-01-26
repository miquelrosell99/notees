/**
 * ConditionBlock Component
 * 
 * Renders and edits a single condition in the query AST.
 * Handles all condition types: type, property, content, reference, etc.
 */

import { mdiClose } from '@mdi/js';
import { Button } from '../core/Button';
import { TextField } from '../core/TextField';
import { Dropdown } from '../core/Dropdown';
import type { ConditionNode } from '@/types/queryAST';
import './ConditionBlock.css';

// ==================== Types ====================

interface ConditionBlockProps {
  condition: ConditionNode;
  onUpdate: (condition: ConditionNode) => void;
  onDelete?: () => void;
  readOnly?: boolean;
}

// ==================== Main Component ====================

export function ConditionBlock({
  condition,
  onUpdate,
  onDelete,
  readOnly = false,
}: ConditionBlockProps) {
  // Handle type condition
  if (condition.condition_type === 'type') {
    return (
      <div className="condition-block condition-block--type">
        <span className="condition-block__label">Type is</span>
        <span className="condition-block__value">{condition.type_uuid}</span>
        {!readOnly && onDelete && (
          <Button
            icon={mdiClose}
            iconOnly
            variant="ghost"
            size="xs"
            onClick={onDelete}
            title="Remove condition"
          />
        )}
      </div>
    );
  }
  
  // Handle content condition
  if (condition.condition_type === 'content') {
    return (
      <div className="condition-block condition-block--content">
        <span className="condition-block__label">Content</span>
        <Dropdown
          value={condition.operator}
          onChange={(value) => onUpdate({ ...condition, operator: value as any })}
          disabled={readOnly}
          options={[
            { value: 'contains', label: 'contains' },
            { value: 'starts_with', label: 'starts with' },
            { value: 'ends_with', label: 'ends with' },
            { value: 'equals', label: 'equals' },
            { value: 'regex', label: 'matches regex' },
          ]}
        />
        <TextField
          value={condition.value}
          onChange={(e) => onUpdate({ ...condition, value: e.target.value })}
          placeholder="Enter text..."
          disabled={readOnly}
        />
        {!readOnly && onDelete && (
          <Button
            icon={mdiClose}
            iconOnly
            variant="ghost"
            size="xs"
            onClick={onDelete}
            title="Remove condition"
          />
        )}
      </div>
    );
  }
  
  // Handle property condition
  if (condition.condition_type === 'property') {
    return (
      <div className="condition-block condition-block--property">
        <span className="condition-block__label">Property</span>
        <TextField
          value={condition.property_name}
          onChange={(e) => onUpdate({ ...condition, property_name: e.target.value })}
          placeholder="Property name..."
          disabled={readOnly}
        />
        <Dropdown
          value={condition.operator}
          onChange={(value) => onUpdate({ ...condition, operator: value as any })}
          disabled={readOnly}
          options={[
            { value: 'equals', label: 'equals' },
            { value: 'not_equals', label: 'not equals' },
            { value: 'greater_than', label: 'greater than' },
            { value: 'less_than', label: 'less than' },
            { value: 'contains', label: 'contains' },
            { value: 'is_empty', label: 'is empty' },
            { value: 'is_not_empty', label: 'is not empty' },
          ]}
        />
        {condition.operator !== 'is_empty' && condition.operator !== 'is_not_empty' && (
          <TextField
            value={String(condition.value || '')}
            onChange={(e) => onUpdate({ ...condition, value: e.target.value })}
            placeholder="Value..."
            disabled={readOnly}
          />
        )}
        {!readOnly && onDelete && (
          <Button
            icon={mdiClose}
            iconOnly
            variant="ghost"
            size="xs"
            onClick={onDelete}
            title="Remove condition"
          />
        )}
      </div>
    );
  }
  
  // Handle reference condition
  if (condition.condition_type === 'reference') {
    return (
      <div className="condition-block condition-block--reference">
        <span className="condition-block__label">References</span>
        <span className="condition-block__value">{condition.target_uuid}</span>
        {!readOnly && onDelete && (
          <Button
            icon={mdiClose}
            iconOnly
            variant="ghost"
            size="xs"
            onClick={onDelete}
            title="Remove condition"
          />
        )}
      </div>
    );
  }
  
  // Fallback for other condition types
  return (
    <div className="condition-block condition-block--unknown">
      <span className="condition-block__label">
        {condition.condition_type} condition
      </span>
      {!readOnly && onDelete && (
        <Button
          icon={mdiClose}
          iconOnly
          variant="ghost"
          size="xs"
          onClick={onDelete}
          title="Remove condition"
        />
      )}
    </div>
  );
}

export default ConditionBlock;
