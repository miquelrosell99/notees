/**
 * PivotView – N-dimensional pivot table with collapsible row headers.
 *
 * Uses backend aggregation. Rows and columns are configurable dimensions;
 * the measure can be node count or a numeric property aggregate.
 * Clicking a cell opens a modal with the matching nodes.
 */
import { useMemo, useState, useCallback, memo } from 'react';
import type { JSX } from 'react';
import type { Node, Property } from '@/types';
import type { NodePivotViewProps } from '@/types/nodeCollection';
import type { QueryGroupResult } from '@/types/nodeView';
import type { QueryAST, PropertyCondition, ConditionNode } from '@/types/queryAST';
import { useProperties, usePivotAggregate } from '@/features/content';
import { executeQuery } from '@/api/nodeViews';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { Icon } from '@/components/ui/icons';
import { NodeCollection } from '../NodeCollection';
import { registerView } from './registry';

import './PivotView.css';

// ==================== Types ====================

interface DimensionConfig {
  field: string; // builtin or property UUID
  label: string;
  property_type?: 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'multi_select' | 'node' | 'url' | 'email';
}

interface MeasureConfig {
  function: 'count' | 'sum' | 'avg' | 'min' | 'max';
  field?: string; // property UUID for numeric property
  property_type?: 'number';
  label: string;
}

interface PivotGroup {
  rowValues: (string | null)[];
  colValues: (string | null)[];
  value: number;
}

interface RowTreeNode {
  value: string | null;
  children: RowTreeNode[];
  leaf?: boolean;
  rowValues?: (string | null)[];
  colMap?: Map<string, number>;
  subtotals?: Map<string, number>;
}

// ==================== Constants ====================

const BUILTIN_DIMENSIONS: DimensionConfig[] = [
  { field: 'is_page', label: 'page type', property_type: 'checkbox' },
  { field: 'create_date', label: 'create date', property_type: 'date' },
  { field: 'write_date', label: 'write date', property_type: 'date' },
  { field: 'open_date', label: 'open date', property_type: 'date' },
];

const MEASURE_FUNCTIONS: { value: 'sum' | 'avg' | 'min' | 'max'; label: string }[] = [
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' },
];

// ==================== Helpers ====================

function findPropertyType(uuid: string, properties: { uuid: string; type: string; name: string }[]): DimensionConfig['property_type'] {
  const prop = properties.find(p => p.uuid === uuid);
  if (!prop) return 'text';
  const map: Record<string, DimensionConfig['property_type']> = {
    text: 'text',
    integer: 'number',
    float: 'number',
    date: 'date',
    boolean: 'checkbox',
    select: 'select',
    multi_select: 'multi_select',
    node: 'node',
    url: 'url',
    email: 'email',
  };
  return map[prop.type] ?? 'text';
}

function buildDimensionOptions(properties: Property[]): DimensionConfig[] {
  return [
    ...BUILTIN_DIMENSIONS,
    ...properties.map(p => ({ field: p.uuid, label: p.name, property_type: findPropertyType(p.uuid, properties) })),
  ];
}

function buildMeasureOptions(properties: Property[]): { value: string; label: string; config: MeasureConfig }[] {
  const options: { value: string; label: string; config: MeasureConfig }[] = [
    { value: 'count', label: 'Count of nodes', config: { function: 'count', label: 'Count of nodes' } },
  ];
  for (const prop of properties) {
    if (prop.type === 'integer' || prop.type === 'float') {
      for (const fn of MEASURE_FUNCTIONS) {
        options.push({
          value: `${fn.value}:${prop.uuid}`,
          label: `${fn.label} of ${prop.name}`,
          config: { function: fn.value, field: prop.uuid, property_type: 'number', label: `${fn.label} of ${prop.name}` },
        });
      }
    }
  }
  return options;
}

function parseGroups(groups: QueryGroupResult[], rowCount: number, colCount: number): PivotGroup[] {
  return groups.map(g => {
    const rowValues: (string | null)[] = [];
    for (let i = 0; i < rowCount; i++) {
      const v = g[`dim_${i}`] as string | number | null | undefined;
      rowValues.push(v == null ? null : String(v));
    }
    const colValues: (string | null)[] = [];
    for (let i = 0; i < colCount; i++) {
      const v = g[`dim_${rowCount + i}`] as string | number | null | undefined;
      colValues.push(v == null ? null : String(v));
    }
    return { rowValues, colValues, value: Number(g.value) };
  });
}

function keyFor(values: (string | null)[]): string {
  return JSON.stringify(values);
}

function buildRowTree(groups: PivotGroup[], rowCount: number): { tree: RowTreeNode; colKeys: string[] } {
  const root: RowTreeNode = { value: null, children: [], leaf: rowCount === 0 };
  const colKeysSet = new Set<string>();

  for (const g of groups) {
    const colKey = keyFor(g.colValues);
    colKeysSet.add(colKey);
    let current = root;
    for (let depth = 0; depth < rowCount; depth++) {
      const v = g.rowValues[depth];
      let child = current.children.find(c => c.value === v);
      if (!child) {
        child = { value: v, children: [], leaf: depth === rowCount - 1 };
        current.children.push(child);
      }
      current = child;
    }
    if (!current.colMap) current.colMap = new Map();
    current.colMap.set(colKey, (current.colMap.get(colKey) ?? 0) + g.value);
  }

  const colKeys = Array.from(colKeysSet).sort();
  sortRowTree(root);
  computeSubtotals(root);
  return { tree: root, colKeys };
}

function sortRowTree(node: RowTreeNode) {
  node.children.sort((a, b) => compareValues(a.value, b.value));
  for (const child of node.children) sortRowTree(child);
}

function compareValues(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (!Number.isNaN(Number(a)) && !Number.isNaN(Number(b))) return Number(a) - Number(b);
  return a.localeCompare(b);
}

function computeSubtotals(node: RowTreeNode): Map<string, number> {
  if (node.children.length === 0) {
    return node.colMap ?? new Map();
  }
  const totals = new Map<string, number>();
  for (const child of node.children) {
    const childTotals = computeSubtotals(child);
    for (const [k, v] of childTotals) {
      totals.set(k, (totals.get(k) ?? 0) + v);
    }
  }
  node.subtotals = totals;
  return totals;
}

function buildDrilldownAst(baseAst: QueryAST | undefined, dimensions: DimensionConfig[], values: (string | null)[]): QueryAST {
  const ast: QueryAST = baseAst && typeof baseAst === 'object'
    ? JSON.parse(JSON.stringify(baseAst))
    : {
        type: 'query',
        version: '1.0',
        scope: { type: 'scope', scope_type: 'entire_workspace' },
        root_group: { type: 'group', logic: 'AND', children: [] },
      };

  for (let i = 0; i < dimensions.length; i++) {
    const dim = dimensions[i];
    const val = values[i];
    if (val == null) continue;

    let condition: ConditionNode;
    if (dim.field === 'is_page') {
      condition = {
        type: 'condition',
        condition_type: 'property',
        property_name: 'is_page',
        property_type: 'checkbox',
        operator: 'equals',
        value: val === 'true',
      };
    } else if (dim.property_type === 'date') {
      condition = {
        type: 'condition',
        condition_type: 'property',
        property_name: dim.field,
        property_type: 'date',
        operator: 'equals',
        value: val,
      };
    } else {
      condition = {
        type: 'condition',
        condition_type: 'property',
        property_name: dim.field,
        property_uuid: dim.property_type ? undefined : dim.field,
        property_type: dim.property_type ?? 'text',
        operator: 'equals',
        value: val,
      } as PropertyCondition;
    }
    ast.root_group.children.push(condition);
  }

  return ast;
}

// ==================== Components ====================

export const PivotView = memo(function PivotView({
  nodes: _nodes,
  className = '',
  queryAst,
  viewId,
  nodeUuid,
  onNodeClick,
}: NodePivotViewProps) {
  const { data: allProperties = [] } = useProperties();
  const dimensionOptions = useMemo(() => buildDimensionOptions(allProperties), [allProperties]);
  const measureOptions = useMemo(() => buildMeasureOptions(allProperties), [allProperties]);

  const [rowDimensions, setRowDimensions] = useState<DimensionConfig[]>([]);
  const [colDimensions, setColDimensions] = useState<DimensionConfig[]>([]);
  const [measure, setMeasure] = useState<MeasureConfig>({ function: 'count', label: 'Count of nodes' });
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

  const [drilldownOpen, setDrilldownOpen] = useState(false);
  const [drilldownNodes, setDrilldownNodes] = useState<Node[]>([]);
  const [drilldownTitle, setDrilldownTitle] = useState('');
  const [drilldownLoading, setDrilldownLoading] = useState(false);

  const aggregation = useMemo(() => ({
    type: 'aggregation' as const,
    dimensions: [...rowDimensions, ...colDimensions].map(d => ({
      type: 'dimension' as const,
      field: d.field,
      property_type: d.property_type,
    })),
    measure: {
      type: 'measure' as const,
      function: measure.function,
      field: measure.field,
      property_type: measure.property_type,
    },
  }), [rowDimensions, colDimensions, measure]);

  const { data: aggregateResult, isLoading: isAggregateLoading } = usePivotAggregate(
    viewId,
    aggregation,
    nodeUuid
  );

  const { tree, colKeys } = useMemo(() => {
    const g = aggregateResult?.groups ? parseGroups(aggregateResult.groups, rowDimensions.length, colDimensions.length) : [];
    return buildRowTree(g, rowDimensions.length);
  }, [aggregateResult, rowDimensions.length, colDimensions.length]);

  const colHeaders = useMemo(() => {
    return colKeys.map(k => JSON.parse(k) as (string | null)[]);
  }, [colKeys]);

  const addDimension = useCallback((list: DimensionConfig[], setList: (l: DimensionConfig[]) => void, field: string) => {
    const config = dimensionOptions.find(d => d.field === field);
    if (!config) return;
    setList([...list, config]);
  }, [dimensionOptions]);

  const removeDimension = useCallback((list: DimensionConfig[], setList: (l: DimensionConfig[]) => void, idx: number) => {
    const next = [...list];
    next.splice(idx, 1);
    setList(next);
  }, []);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleCellClick = useCallback(async (rowValues: (string | null)[], colValues: (string | null)[]) => {
    const dimensions = [...rowDimensions, ...colDimensions];
    const values = [...rowValues, ...colValues];
    const ast = buildDrilldownAst(queryAst, dimensions, values);
    setDrilldownTitle('Matching nodes');
    setDrilldownOpen(true);
    setDrilldownLoading(true);
    try {
      const result = await executeQuery({
        query_ast: ast,
        runtime_params: { current_node_uuid: nodeUuid },
        include_properties: true,
      });
      setDrilldownNodes(result.nodes);
    } catch (e) {
      console.error('Drill-down query failed', e);
      setDrilldownNodes([]);
    } finally {
      setDrilldownLoading(false);
    }
  }, [queryAst, rowDimensions, colDimensions, nodeUuid]);

  const measureValue = useMemo(() => {
    if (measure.function === 'count') return 'count';
    return `${measure.function}:${measure.field}`;
  }, [measure]);

  if (isAggregateLoading) {
    return <div className={`pivot-view pivot-view--empty ${className}`}><Spinner size="sm" /></div>;
  }

  return (
    <div className={`pivot-view ${className}`}>
      <div className="pivot-view__toolbar">
        <DimensionPicker
          label="Rows"
          options={dimensionOptions}
          selected={rowDimensions}
          onAdd={(field) => addDimension(rowDimensions, setRowDimensions, field)}
          onRemove={(idx) => removeDimension(rowDimensions, setRowDimensions, idx)}
        />
        <DimensionPicker
          label="Columns"
          options={dimensionOptions}
          selected={colDimensions}
          onAdd={(field) => addDimension(colDimensions, setColDimensions, field)}
          onRemove={(idx) => removeDimension(colDimensions, setColDimensions, idx)}
        />
        <div className="pivot-view__control">
          <span className="pivot-view__control-label">Measure</span>
          <select
            value={measureValue}
            onChange={(e) => {
              const selected = measureOptions.find(o => o.value === e.target.value);
              if (selected) setMeasure(selected.config);
            }}
            className="pivot-view__control-select"
          >
            {measureOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="pivot-view__table-wrap">
        {rowDimensions.length === 0 && colDimensions.length === 0 ? (
          <div className="pivot-view__empty">Choose row/column dimensions and a measure.</div>
        ) : (
          <table className="pivot-view__table">
            <thead>
              <tr>
                <th colSpan={Math.max(rowDimensions.length, 1)} className="pivot-view__corner">
                  {rowDimensions.length === 0 ? 'Total' : 'Rows \\ Columns'}
                </th>
                {colHeaders.map((col, i) => (
                  <th key={i} className="pivot-view__col-header">
                    {col.map((v, j) => (
                      <span key={j} className="pivot-view__col-header-part">{v ?? '(No value)'}</span>
                    ))}
                  </th>
                ))}
                <th className="pivot-view__col-header pivot-view__total-header">Total</th>
              </tr>
            </thead>
            <tbody>
              {rowDimensions.length === 0 ? (
                <tr>
                  <td className="pivot-view__row-header">Total</td>
                  {colKeys.map(k => (
                    <td key={k} className="pivot-view__cell" onClick={() => handleCellClick([], JSON.parse(k))}>
                      {formatValue(tree.subtotals?.get(k) ?? 0, measure.function)}
                    </td>
                  ))}
                  <td className="pivot-view__cell pivot-view__total-cell">
                    {formatValue(Array.from(tree.subtotals?.values() ?? []).reduce((a, b) => a + b, 0), measure.function)}
                  </td>
                </tr>
              ) : (
                <RowTreeRows
                  node={tree}
                  depth={-1}
                  rowCount={rowDimensions.length}
                  colKeys={colKeys}
                  colCount={colDimensions.length}
                  collapsedKeys={collapsedKeys}
                  onToggle={toggleCollapsed}
                  onCellClick={handleCellClick}
                  measureFunction={measure.function}
                />
              )}
            </tbody>
          </table>
        )}
      </div>

      <Modal isOpen={drilldownOpen} onClose={() => setDrilldownOpen(false)} title={drilldownTitle} size="lg">
        <div className="pivot-view__drilldown">
          {drilldownLoading ? (
            <Spinner size="sm" />
          ) : (
            <NodeCollection
              nodes={drilldownNodes}
              viewMode="list"
              editable={false}
              onNodeClick={onNodeClick}
              showEmpty
              emptyMessage="No nodes match this cell"
            />
          )}
        </div>
      </Modal>
    </div>
  );
});

function DimensionPicker({
  label,
  options,
  selected,
  onAdd,
  onRemove,
}: {
  label: string;
  options: DimensionConfig[];
  selected: DimensionConfig[];
  onAdd: (field: string) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="pivot-view__control-group">
      <span className="pivot-view__control-label">{label}</span>
      <div className="pivot-view__dimension-list">
        {selected.map((dim, idx) => (
          <span key={`${dim.field}-${idx}`} className="pivot-view__dimension-chip">
            {dim.label}
            <button type="button" onClick={() => onRemove(idx)} className="pivot-view__dimension-remove" aria-label={`Remove ${dim.label}`}>
              <Icon path="mdi mdi-close" size={0.6} />
            </button>
          </span>
        ))}
      </div>
      <select
        value=""
        onChange={(e) => { if (e.target.value) { onAdd(e.target.value); e.target.value = ''; } }}
        className="pivot-view__control-select"
      >
        <option value="">Add {label.toLowerCase()}...</option>
        {options.map(opt => (
          <option key={opt.field} value={opt.field}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

interface RowTreeRowsProps {
  node: RowTreeNode;
  depth: number;
  rowCount: number;
  colKeys: string[];
  colCount: number;
  collapsedKeys: Set<string>;
  onToggle: (key: string) => void;
  onCellClick: (rowValues: (string | null)[], colValues: (string | null)[]) => void;
  measureFunction: MeasureConfig['function'];
}

function RowTreeRows({
  node,
  depth,
  rowCount,
  colKeys,
  colCount: _colCount,
  collapsedKeys,
  onToggle,
  onCellClick,
  measureFunction,
}: RowTreeRowsProps): JSX.Element[] {
  const rows: JSX.Element[] = [];

  for (const child of node.children) {
    const pathKey = JSON.stringify(child.rowValues ?? []);
    const isCollapsed = collapsedKeys.has(pathKey);
    const hasChildren = child.children.length > 0;

    rows.push(
      <RowTreeRow
        key={pathKey}
        node={child}
        depth={depth + 1}
        rowCount={rowCount}
        colKeys={colKeys}
        isCollapsed={isCollapsed}
        hasChildren={hasChildren}
        onToggle={() => onToggle(pathKey)}
        onCellClick={onCellClick}
        measureFunction={measureFunction}
      />
    );

    if (!isCollapsed && hasChildren) {
      rows.push(
        ...RowTreeRows({
          node: child,
          depth: depth + 1,
          rowCount,
          colKeys,
          colCount: _colCount,
          collapsedKeys,
          onToggle,
          onCellClick,
          measureFunction,
        })
      );
    }
  }

  return rows;
}

function RowTreeRow({
  node,
  depth,
  rowCount,
  colKeys,
  isCollapsed,
  hasChildren,
  onToggle,
  onCellClick,
  measureFunction,
}: Omit<RowTreeRowProps, 'colCount'> & { isCollapsed: boolean; hasChildren: boolean }) {
  const values = node.rowValues ?? [];
  const isLeaf = depth === rowCount - 1;
  const rowTotal = Array.from((isLeaf ? node.colMap : node.subtotals)?.values() ?? []).reduce((a, b) => a + b, 0);

  return (
    <tr>
      {/* Indent cells */}
      {Array.from({ length: depth }, (_, i) => (
        <td key={i} className="pivot-view__indent-cell" />
      ))}
      <td
        className={`pivot-view__row-header ${isLeaf ? 'pivot-view__row-header--leaf' : ''}`}
        colSpan={isLeaf ? rowCount - depth : 1}
      >
        {hasChildren && (
          <button type="button" onClick={onToggle} className="pivot-view__collapse-btn" aria-label={isCollapsed ? 'Expand' : 'Collapse'}>
            <Icon path={isCollapsed ? 'mdi mdi-chevron-right' : 'mdi mdi-chevron-down'} size={0.7} />
          </button>
        )}
        <span>{values[depth] ?? '(No value)'}</span>
      </td>
      {isLeaf ? (
        <>
          {colKeys.map(k => (
            <td key={k} className="pivot-view__cell" onClick={() => onCellClick(values, JSON.parse(k))}>
              {formatValue(node.colMap?.get(k) ?? 0, measureFunction)}
            </td>
          ))}
          <td className="pivot-view__cell pivot-view__total-cell">{formatValue(rowTotal, measureFunction)}</td>
        </>
      ) : (
        <>
          {colKeys.map(k => (
            <td key={k} className="pivot-view__cell" onClick={() => onCellClick(values, JSON.parse(k))}>
              {formatValue(node.subtotals?.get(k) ?? 0, measureFunction)}
            </td>
          ))}
          <td className="pivot-view__cell pivot-view__total-cell">{formatValue(rowTotal, measureFunction)}</td>
        </>
      )}
    </tr>
  );
}

interface RowTreeRowProps {
  node: RowTreeNode;
  depth: number;
  rowCount: number;
  colKeys: string[];
  onToggle: () => void;
  onCellClick: (rowValues: (string | null)[], colValues: (string | null)[]) => void;
  measureFunction: MeasureConfig['function'];
}

function formatValue(value: number, fn: MeasureConfig['function']): string {
  if (value == null) return '-';
  if (Number.isInteger(value)) return String(value);
  if (fn === 'count') return String(Math.round(value));
  return value.toFixed(2);
}

registerView({
  id: 'pivot',
  label: 'Pivot',
  icon: 'mdi mdi-table-pivot',
  component: PivotView,
  capabilities: { groupBy: false },
});
