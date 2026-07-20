/**
 * Minimal local parser for the compact query language.
 *
 * Supports the documented example:
 *   content:"meeting" AND create_date >= {this_week}
 *
 * Unsupported input throws a clear error.
 */

import type { QueryAST, ConditionNode, PropertyCondition } from '@/types/queryAST';
import { getTodayDayUuid, dateToDayUuid } from '@/utils/dateUuid';

type Comparator = '>=' | '<=' | '>' | '<' | '=' | '!=';

const COMPARATORS: Comparator[] = ['>=', '<=', '!=', '=', '>', '<'];

function startOfWeek(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday as first day
  return new Date(d.setDate(diff));
}

function resolvePlaceholder(token: string): string {
  if (token === '{today}') return getTodayDayUuid();
  if (token === '{this_week}') return dateToDayUuid(startOfWeek(new Date()));
  if (token.startsWith('{') || token.endsWith('}')) {
    throw new Error(`Unsupported placeholder: ${token}`);
  }
  return token;
}

function parseContentToken(token: string): ConditionNode {
  const colonIdx = token.indexOf(':');
  if (colonIdx === -1) throw new Error(`Invalid content token: ${token}`);
  const value = token.slice(colonIdx + 1).replace(/^"|"$/g, '');
  if (!value) throw new Error('content value cannot be empty');
  return {
    type: 'condition',
    condition_type: 'content',
    operator: 'contains',
    value,
  };
}

function parseDateCondition(field: string, comparator: Comparator, placeholder: string): PropertyCondition {
  const value = resolvePlaceholder(placeholder);
  const operatorMap: Record<Comparator, PropertyCondition['operator']> = {
    '>=': 'gte',
    '<=': 'lte',
    '>': 'greater_than',
    '<': 'less_than',
    '=': 'equals',
    '!=': 'not_equals',
  };
  return {
    type: 'condition',
    condition_type: 'property',
    property_name: field,
    property_type: 'date',
    operator: operatorMap[comparator],
    value,
  };
}

/**
 * Parse a compact text query into a QueryAST.
 *
 * Example:
 *   parseQueryLanguage('content:"meeting" AND create_date >= {this_week}')
 */
export function parseQueryLanguage(queryLanguage: string): QueryAST {
  const input = queryLanguage.trim();
  if (!input) throw new Error('Query cannot be empty');

  const parts = input.split(/\s+AND\s+/i);

  const children: ConditionNode[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.toLowerCase().startsWith('content:')) {
      children.push(parseContentToken(trimmed));
      continue;
    }

    // date field comparator placeholder, e.g. create_date >= {this_week}
    let comparator: Comparator | undefined;
    let comparatorIdx = -1;
    for (const cmp of COMPARATORS) {
      const idx = trimmed.indexOf(cmp);
      if (idx !== -1 && (comparatorIdx === -1 || idx < comparatorIdx)) {
        comparator = cmp;
        comparatorIdx = idx;
      }
    }

    if (!comparator) {
      throw new Error(`Unsupported query clause: "${trimmed}"`);
    }

    const field = trimmed.slice(0, comparatorIdx).trim();
    const placeholder = trimmed.slice(comparatorIdx + comparator.length).trim();

    if (!field || !placeholder) {
      throw new Error(`Invalid date clause: "${trimmed}"`);
    }

    if (field !== 'create_date' && field !== 'write_date') {
      throw new Error(`Unsupported date field: ${field}`);
    }

    children.push(parseDateCondition(field, comparator, placeholder));
  }

  if (children.length === 0) {
    throw new Error('No query conditions could be parsed');
  }

  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children,
    },
  };
}
