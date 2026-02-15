/**
 * QuerySQLPreview Component
 * 
 * Displays a read-only generated SQL preview from the query AST.
 * Collapsed by default, helps users understand the underlying query.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from 'react';
import { mdiChevronDown, mdiChevronRight, mdiCodeTags } from '@mdi/js';
import Icon from '@mdi/react';
import type { QueryAST } from '@/types/queryAST';
import './QuerySQLPreview.css';

interface QuerySQLPreviewProps {
  ast: QueryAST;
  disabled?: boolean;
}

/**
 * Generate SQL-like representation from AST
 * This is a simplified representation, not actual executable SQL
 */
function generateSQL(ast: QueryAST): string {
  const lines: string[] = [];
  
  lines.push('-- Query AST as SQL-like pseudocode');
  lines.push('-- This is for understanding only, not executable');
  lines.push('');
  lines.push('SELECT nodes.*');
  lines.push('FROM nodes');
  
  // Generate WHERE clause from scope and conditions
  const whereClauses: string[] = [];
  
  // Scope conditions
  const scopeConditions = generateScopeSQL(ast);
  if (scopeConditions) {
    whereClauses.push(scopeConditions);
  }
  
  // Root group conditions
  const groupConditions = generateGroupSQL(ast.root_group, 0);
  if (groupConditions) {
    whereClauses.push(groupConditions);
  }
  
  if (whereClauses.length > 0) {
    lines.push('WHERE');
    lines.push('  ' + whereClauses.join(' AND\n  '));
  } else {
    lines.push('-- No conditions applied');
  }
  
  return lines.join('\n');
}

function generateScopeSQL(ast: QueryAST): string {
  const scope = ast.scope;
  
  switch (scope.scope_type) {
    case 'entire_workspace':
      return '-- Scope: Entire workspace (no restriction)';
      
    case 'current_page':
      return 'ancestor_of(nodes.id, {current_page_id})';
      
    default:
      // Handle specific_pages and linked_refs as unknown scope types
      if ((scope as any).page_uuids) {
        const pageList = (scope as any).page_uuids.map((uuid: string) => `'${uuid}'`).join(', ');
        return `ancestor_uuid IN (${pageList})`;
      }
      return '';
  }
}

function generateGroupSQL(group: import('@/types/queryAST').GroupNode, indent: number): string {
  if (group.children.length === 0) {
    return '';
  }
  
  const indentStr = '  '.repeat(indent);
  const childIndentStr = '  '.repeat(indent + 1);
  
  const childSQLs = group.children
    .map(child => {
      if (child.type === 'group') {
        const groupSQL = generateGroupSQL(child, indent + 1);
        return groupSQL ? `(\n${childIndentStr}${groupSQL}\n${indentStr})` : '';
      } else if (child.type === 'not') {
        const innerSQL = child.child.type === 'group'
          ? generateGroupSQL(child.child, indent + 1)
          : generateConditionSQL(child.child as import('@/types/queryAST').ConditionNode);
        return innerSQL ? `NOT (${innerSQL})` : '';
      } else {
        return generateConditionSQL(child);
      }
    })
    .filter(sql => sql !== '');
  
  if (childSQLs.length === 0) {
    return '';
  }
  
  const logicOp = group.logic === 'AND' ? 'AND' : 'OR';
  return childSQLs.join(`\n${indentStr}${logicOp} `);
}

function generateConditionSQL(condition: import('@/types/queryAST').ConditionNode): string {
  switch (condition.condition_type) {
    case 'class':
      return `has_class('${condition.class_uuid}')`;
      
    case 'property': {
      const op = condition.operator;
      const val = condition.value;
      const propName = condition.property_name;
      
      if (op === 'is_empty') {
        return `${propName} IS NULL`;
      } else if (op === 'is_not_empty') {
        return `${propName} IS NOT NULL`;
      } else if (op === 'contains') {
        return `${propName} LIKE '%${val}%'`;
      } else if (op === 'starts_with') {
        return `${propName} LIKE '${val}%'`;
      } else if (op === 'ends_with') {
        return `${propName} LIKE '%${val}'`;
      } else {
        return `${propName} ${op} '${val}'`;
      }
    }
      
    case 'content': {
      const op = condition.operator;
      const val = condition.value;
      
      if (op === 'contains') {
        return `content LIKE '%${val}%'`;
      } else if (op === 'equals') {
        return `content = '${val}'`;
      } else if (op === 'starts_with') {
        return `content LIKE '${val}%'`;
      } else if (op === 'ends_with') {
        return `content LIKE '%${val}'`;
      } else if (op === 'fts') {
        return `MATCH(content) AGAINST('${val}')`;
      } else {
        return `content ${op} '${val}'`;
      }
    }
      
    case 'reference':
      return `references('${condition.target_uuid}')`;
      
    case 'reference_path': {
      const rpCond = condition as any;
      if (rpCond.target_uuids?.length > 0) {
        const uuids = rpCond.target_uuids.map((u: string) => `'${u}'`).join(', ');
        return `reference_path(${uuids})`;
      }
      return `reference_path(...)`;
    }
      
    case 'parent_path':
      return `inside_page(...)`;
      
    default:
      return '';
  }
}

export function QuerySQLPreview({ ast, disabled = false }: QuerySQLPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  if (disabled) {
    return null;
  }
  
  const sql = generateSQL(ast);
  
  return (
    <div className="query-sql-preview">
      <button
        className="query-sql-preview__toggle"
        onClick={() => setIsExpanded(!isExpanded)}
        type="button"
      >
        <Icon path={isExpanded ? mdiChevronDown : mdiChevronRight} size={0.7} />
        <Icon path={mdiCodeTags} size={0.7} />
        <span>Generated SQL</span>
        <span className="query-sql-preview__hint">(read-only preview)</span>
      </button>
      
      {isExpanded && (
        <pre className="query-sql-preview__code">
          {sql}
        </pre>
      )}
    </div>
  );
}

export default QuerySQLPreview;
