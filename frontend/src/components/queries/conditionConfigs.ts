/**
 * Condition Configuration
 * 
 * Unified configuration for all query condition types.
 * Eliminates repetitive switch statements by defining structure for each condition.
 */

import {
  CONTENT_OPERATORS,
  PROPERTY_OPERATORS,
  CLASS_OPERATORS,
  REFERENCE_OPERATORS,
  PARENT_OPERATORS,
  CHILD_OPERATORS,
  PARENT_PATH_OPERATORS,
  CHILD_PATH_OPERATORS,
  FLAG_OPERATORS,
  type OperatorDefinition,
} from './operators';

// ==================== Types ====================

export type InputType = 
  | 'text'              // Simple text input
  | 'node-selector'     // Single node picker (pages)
  | 'class-selector'    // Class picker
  | 'property-selector' // Property name picker
  | 'none';             // No input needed (e.g., is_empty operator)

export interface StaticModeConfig {
  inputType: InputType;
  placeholder: string;
  /** Whether this input requires a value to be valid */
  required?: boolean;
  /** Whether multiple nodes can be selected (for node-selector) */
  allowMultiple?: boolean;
}

export interface DynamicModeConfig {
  /** Label shown before nested group (e.g., "where") */
  whereLabel: string;
  /** Default logic for nested group */
  defaultLogic?: 'AND' | 'OR';
}

export interface ConditionConfig {
  /** Display label for this condition */
  label: string;
  
  /** Available operators */
  operators: OperatorDefinition[];
  
  /** Default operator when creating new condition */
  defaultOperator: string;
  
  /** Whether this condition supports static/dynamic toggle */
  hasStaticDynamicToggle: boolean;
  
  /** Configuration for static mode */
  staticMode: StaticModeConfig;
  
  /** Configuration for dynamic mode (if supported) */
  dynamicMode?: DynamicModeConfig;
  
  /** Operators that don't require a value input */
  noValueOperators?: string[];
}

// ==================== Condition Configs ====================

export const CONDITION_CONFIGS: Record<string, ConditionConfig> = {
  content: {
    label: 'content',
    operators: CONTENT_OPERATORS,
    defaultOperator: 'contains',
    hasStaticDynamicToggle: false,
    staticMode: {
      inputType: 'text',
      placeholder: 'text...',
      required: true,
    },
  },
  
  property: {
    label: 'property',
    operators: PROPERTY_OPERATORS,
    defaultOperator: 'equals',
    hasStaticDynamicToggle: true, // For node-type properties
    staticMode: {
      inputType: 'text', // Can be node-selector if property_type is 'node'
      placeholder: 'value',
      required: false,
    },
    dynamicMode: {
      whereLabel: 'where',
      defaultLogic: 'AND',
    },
    noValueOperators: ['is_empty', 'is_not_empty'],
  },
  
  class: {
    label: 'class',
    operators: CLASS_OPERATORS,
    defaultOperator: 'contains',
    hasStaticDynamicToggle: true,
    staticMode: {
      inputType: 'class-selector',
      placeholder: 'Select class',
      required: false,
    },
    dynamicMode: {
      whereLabel: 'where',
      defaultLogic: 'AND',
    },
    noValueOperators: ['defined', 'not_defined'],
  },
  
  reference: {
    label: 'reference',
    operators: REFERENCE_OPERATORS,
    defaultOperator: 'references',
    hasStaticDynamicToggle: true,
    staticMode: {
      inputType: 'node-selector',
      placeholder: 'Select node...',
      required: false,
    },
    dynamicMode: {
      whereLabel: 'where',
      defaultLogic: 'AND',
    },
    noValueOperators: ['has_references', 'has_no_references'],
  },
  
  parent: {
    label: 'parent',
    operators: PARENT_OPERATORS,
    defaultOperator: 'has_parent',
    hasStaticDynamicToggle: true,
    staticMode: {
      inputType: 'node-selector',
      placeholder: 'Select parents...',
      required: true,
      allowMultiple: true,
    },
    dynamicMode: {
      whereLabel: 'where',
      defaultLogic: 'AND',
    },
    noValueOperators: ['has_no_parent', 'has_any_parent'],
  },
  
  parent_path: {
    label: 'inside',
    operators: PARENT_PATH_OPERATORS,
    defaultOperator: 'has_ancestor',
    hasStaticDynamicToggle: true,
    staticMode: {
      inputType: 'node-selector',
      placeholder: 'Select ancestors...',
      required: true,
      allowMultiple: true,
    },
    dynamicMode: {
      whereLabel: 'matching',
      defaultLogic: 'AND',
    },
    noValueOperators: ['has_no_ancestor', 'has_any_ancestor'],
  },
  
  child: {
    label: 'child',
    operators: CHILD_OPERATORS,
    defaultOperator: 'has_child',
    hasStaticDynamicToggle: true,
    staticMode: {
      inputType: 'node-selector',
      placeholder: 'Select children...',
      required: true,
      allowMultiple: true,
    },
    dynamicMode: {
      whereLabel: 'matching',
      defaultLogic: 'AND',
    },
    noValueOperators: ['has_no_child', 'has_any_child'],
  },
  
  child_path: {
    label: 'contains descendant',
    operators: CHILD_PATH_OPERATORS,
    defaultOperator: 'has_descendant',
    hasStaticDynamicToggle: true,
    staticMode: {
      inputType: 'node-selector',
      placeholder: 'Select descendants...',
      required: true,
      allowMultiple: true,
    },
    dynamicMode: {
      whereLabel: 'where',
      defaultLogic: 'AND',
    },
    noValueOperators: ['has_no_descendant', 'has_any_descendant'],
  },
  
  reference_path: {
    label: 'references nodes',
    operators: [{ value: 'references_matching', label: 'matching' }],
    defaultOperator: 'references_matching',
    hasStaticDynamicToggle: true,
    staticMode: {
      inputType: 'node-selector',
      placeholder: 'Select nodes...',
      required: true,
      allowMultiple: true,
    },
    dynamicMode: {
      whereLabel: 'where',
      defaultLogic: 'AND',
    },
  },
  
  class_path: {
    label: 'inherited class',
    operators: [{ value: 'has_inherited_class', label: 'from ancestors' }],
    defaultOperator: 'has_inherited_class',
    hasStaticDynamicToggle: true,
    staticMode: {
      inputType: 'class-selector',
      placeholder: 'Select classes...',
      required: true,
      allowMultiple: true,
    },
    dynamicMode: {
      whereLabel: 'where class',
      defaultLogic: 'AND',
    },
  },
  
  flag: {
    label: 'flag',
    operators: FLAG_OPERATORS,
    defaultOperator: 'is_true',
    hasStaticDynamicToggle: false,
    staticMode: {
      inputType: 'text', // For flag name selection
      placeholder: 'Select flag...',
      required: true,
    },
  },
};

// ==================== Helper Functions ====================

/**
 * Get configuration for a condition type
 */
export function getConditionConfig(conditionType: string): ConditionConfig | undefined {
  return CONDITION_CONFIGS[conditionType];
}

/**
 * Check if an operator requires a value input
 */
export function operatorNeedsValue(conditionType: string, operator: string): boolean {
  const config = getConditionConfig(conditionType);
  if (!config) return true;
  
  return !config.noValueOperators?.includes(operator);
}

/**
 * Check if a condition type always uses nested groups
 */
export function alwaysUsesNestedGroup(conditionType: string): boolean {
  // All conditions now support both static and dynamic modes
  return false;
}
