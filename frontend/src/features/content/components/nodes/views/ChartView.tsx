/**
 * ChartView – Bar and pie chart aggregation view for NodeCollection
 *
 * Groups nodes by a selected property and renders counts as SVG charts.
 * No external charting library — pure SVG + React.
 *
 * When the QueryAST contains a backend aggregation node and a NodeView ID is
 * available, the chart fetches pre-aggregated counts from the server. Otherwise
 * it falls back to client-side grouping using the node list.
 */
import { useMemo, useState, useCallback, memo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Node } from '@/types';
import type { Property } from '@/types/api';
import type { NodeChartViewProps } from '@/types/nodeCollection';
import type { QueryGroupResult } from '@/types/nodeView';
import { useProperties } from '@/hooks';
import { executeNodeViewQuery } from '@/api/nodeViews';
import { Icon } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/Spinner';
import { registerView } from './registry';
import './ChartView.css';

// ==================== Pure helpers ====================

interface ChartDatum {
  label: string;
  count: number;
  color: string;
}

const CHART_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

function getPropertyGroupLabel(property: Property, rawValue: unknown): string {
  if (rawValue == null) return '(No value)';
  switch (property.type) {
    case 'boolean':
      return rawValue ? 'Yes' : 'No';
    case 'selection': {
      const getId = (v: unknown): number | null =>
        typeof v === 'number' ? v
          : (v && typeof v === 'object' && 'id' in v ? (v as { id: number }).id : null);
      const ids = (Array.isArray(rawValue) ? rawValue : [rawValue])
        .map(getId)
        .filter((x): x is number => x !== null);
      const opts = ids.map(id => property.options?.find(o => o.id === id));
      return opts.map(o => o?.name ?? '?').join(', ') || '(No value)';
    }
    default:
      return String(rawValue);
  }
}

function buildChartData(nodes: Node[], property: Property | undefined): ChartDatum[] {
  if (!property) return [];
  const counts = new Map<string, number>();
  const propId = String(property.id);
  for (const node of nodes) {
    const rawValue = (node.properties as Record<string, unknown> | undefined)?.[propId] ?? null;
    const label = getPropertyGroupLabel(property, rawValue);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label, count], i) => ({
      label,
      count,
      color: CHART_COLORS[i % CHART_COLORS.length],
    }));
  return sorted;
}

function buildChartDataFromGroups(groups: QueryGroupResult[]): ChartDatum[] {
  return groups
    .filter(g => g.count > 0)
    .map((g, i) => ({
      label: g.group_key == null || g.group_key === '' ? '(No value)' : String(g.group_key),
      count: g.count,
      color: CHART_COLORS[i % CHART_COLORS.length],
    }));
}

// ==================== BarChart ====================

interface BarChartProps {
  data: ChartDatum[];
  onBarClick?: (label: string) => void;
}

const BarChart = memo(function BarChart({ data, onBarClick }: BarChartProps) {
  if (data.length === 0) return null;

  const maxCount = Math.max(...data.map(d => d.count));
  const chartHeight = 300;
  const chartWidth = Math.max(data.length * 80, 400);
  const barWidth = 50;
  const barGap = 30;
  const margin = { top: 20, right: 20, bottom: 80, left: 50 };
  const innerWidth = chartWidth - margin.left - margin.right;
  const innerHeight = chartHeight - margin.top - margin.bottom;

  return (
    <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="chart-view__svg">
      {/* Y axis */}
      <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + innerHeight} stroke="var(--outline-variant)" />
      {/* X axis */}
      <line x1={margin.left} y1={margin.top + innerHeight} x2={margin.left + innerWidth} y2={margin.top + innerHeight} stroke="var(--outline-variant)" />

      {/* Y ticks */}
      {Array.from({ length: 5 }, (_, i) => {
        const y = margin.top + innerHeight - (i / 4) * innerHeight;
        const value = Math.round((i / 4) * maxCount);
        return (
          <g key={i}>
            <line x1={margin.left - 5} y1={y} x2={margin.left} y2={y} stroke="var(--outline-variant)" />
            <text x={margin.left - 10} y={y + 4} textAnchor="end" fontSize="10" fill="var(--on-surface-variant)">
              {value}
            </text>
          </g>
        );
      })}

      {/* Bars */}
      {data.map((d, i) => {
        const barHeight = maxCount > 0 ? (d.count / maxCount) * innerHeight : 0;
        const x = margin.left + i * (barWidth + barGap) + barGap / 2;
        const y = margin.top + innerHeight - barHeight;

        return (
          <g key={d.label}>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              fill={d.color}
              rx={4}
              className="chart-view__bar"
              onClick={() => onBarClick?.(d.label)}
            />
            {/* Count label */}
            <text x={x + barWidth / 2} y={y - 6} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--on-surface)">
              {d.count}
            </text>
            {/* X label */}
            <text
              x={x + barWidth / 2}
              y={margin.top + innerHeight + 16}
              textAnchor="middle"
              fontSize="10"
              fill="var(--on-surface-variant)"
              transform={`rotate(-30, ${x + barWidth / 2}, ${margin.top + innerHeight + 16})`}
            >
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
});

// ==================== PieChart ====================

interface PieChartProps {
  data: ChartDatum[];
  onSliceClick?: (label: string) => void;
}

const PieChart = memo(function PieChart({ data, onSliceClick }: PieChartProps) {
  const total = data.reduce((sum, d) => sum + d.count, 0);
  const size = 280;
  const radius = size / 2 - 20;
  const center = size / 2;

  // Precompute slice geometries to avoid mutation during render
  const slices = useMemo(() => {
    let currentAngle = -Math.PI / 2;
    const result: Array<ChartDatum & { path: string; labelX: number; labelY: number; showLabel: boolean }> = [];
    for (const d of data) {
      const angle = (d.count / total) * 2 * Math.PI;
      const x1 = center + radius * Math.cos(currentAngle);
      const y1 = center + radius * Math.sin(currentAngle);
      const x2 = center + radius * Math.cos(currentAngle + angle);
      const y2 = center + radius * Math.sin(currentAngle + angle);
      const largeArc = angle > Math.PI ? 1 : 0;
      const path = `M ${center} ${center} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
      const midAngle = currentAngle + angle / 2;
      const labelRadius = radius * 0.65;
      const labelX = center + labelRadius * Math.cos(midAngle);
      const labelY = center + labelRadius * Math.sin(midAngle);
      const showLabel = d.count / total > 0.05;
      result.push({ ...d, path, labelX, labelY, showLabel });
      currentAngle += angle;
    }
    return result;
  }, [data, total, center, radius]);

  if (data.length === 0) return null;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="chart-view__svg">
      {slices.map((slice) => (
        <g key={slice.label}>
          <path
            d={slice.path}
            fill={slice.color}
            stroke="var(--surface)"
            strokeWidth={2}
            className="chart-view__slice"
            onClick={() => onSliceClick?.(slice.label)}
          />
          {slice.showLabel && (
            <text x={slice.labelX} y={slice.labelY} textAnchor="middle" dominantBaseline="middle" fontSize="11" fontWeight="600" fill="white">
              {Math.round((slice.count / total) * 100)}%
            </text>
          )}
        </g>
      ))}
    </svg>
  );
});

// ==================== ChartView ====================

type ChartType = 'bar' | 'pie';

export const ChartView = memo(function ChartView({
  nodes,
  groupByProperty: groupByPropertyProp,
  onNodeClick,
  className = '',
  queryAst,
  viewId,
  nodeUuid,
}: NodeChartViewProps) {
  const [chartType, setChartType] = useState<ChartType>('bar');
  const [selectedPropertyUuid, setSelectedPropertyUuid] = useState<string | undefined>(
    groupByPropertyProp?.uuid
  );

  const { data: allProperties = [] } = useProperties();

  const activeProperty = useMemo(() => {
    if (groupByPropertyProp) return groupByPropertyProp;
    return allProperties.find(p => p.uuid === selectedPropertyUuid);
  }, [groupByPropertyProp, selectedPropertyUuid, allProperties]);

  const hasBackendAggregation = Boolean(queryAst?.aggregation) && viewId != null && viewId > 0;

  const { data: aggregateResult, isLoading: isAggregateLoading } = useQuery({
    queryKey: ['node-view-aggregate', viewId, queryAst?.aggregation, nodeUuid],
    queryFn: async () => {
      if (!viewId || !queryAst?.aggregation) return null;
      return executeNodeViewQuery(viewId, {
        runtime_params: { current_node_uuid: nodeUuid },
        aggregation: queryAst.aggregation,
      });
    },
    enabled: hasBackendAggregation,
    staleTime: 30_000,
  });

  const aggregationLabel = useMemo(() => {
    if (!queryAst?.aggregation) return null;
    const { group_by } = queryAst.aggregation;
    const builtinLabels: Record<string, string> = {
      is_page: 'page type',
      create_date: 'create date',
      write_date: 'write date',
      open_date: 'open date',
      page: 'page',
      class: 'class',
    };
    if (builtinLabels[group_by]) return builtinLabels[group_by];
    const property = allProperties.find(p => p.uuid === group_by);
    return property?.name ?? 'group';
  }, [queryAst?.aggregation, allProperties]);

  const chartData = useMemo(() => {
    if (aggregateResult?.groups) {
      return buildChartDataFromGroups(aggregateResult.groups);
    }
    return buildChartData(nodes, activeProperty);
  }, [aggregateResult, nodes, activeProperty]);

  const handleBarClick = useCallback((label: string) => {
    if (aggregateResult?.groups) return;
    if (!activeProperty) return;
    // Find a representative node in this group and open it
    const propId = String(activeProperty.id);
    const match = nodes.find(n => {
      const rawValue = (n.properties as Record<string, unknown> | undefined)?.[propId] ?? null;
      return getPropertyGroupLabel(activeProperty, rawValue) === label;
    });
    if (match) onNodeClick?.(match);
  }, [nodes, activeProperty, onNodeClick, aggregateResult]);

  // Empty state: no aggregation configured and no property selected
  if (!hasBackendAggregation && !activeProperty) {
    return (
      <div className={`chart-view chart-view--empty ${className}`}>
        <div className="chart-view__empty-msg">
          Choose a property to group and chart.
        </div>
      </div>
    );
  }

  if (isAggregateLoading) {
    return (
      <div className={`chart-view chart-view--empty ${className}`}>
        <Spinner size="sm" />
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className={`chart-view chart-view--empty ${className}`}>
        <div className="chart-view__toolbar">
          <div className="chart-view__type-toggle">
            <button
              className={`chart-view__type-btn ${chartType === 'bar' ? 'chart-view__type-btn--active' : ''}`}
              onClick={() => setChartType('bar')}
              type="button"
            >
              <Icon path="mdi mdi-chart-bar" size={0.7} />
              Bar
            </button>
            <button
              className={`chart-view__type-btn ${chartType === 'pie' ? 'chart-view__type-btn--active' : ''}`}
              onClick={() => setChartType('pie')}
              type="button"
            >
              <Icon path="mdi mdi-chart-pie" size={0.7} />
              Pie
            </button>
          </div>
        </div>
        <div className="chart-view__empty-msg">
          {hasBackendAggregation
            ? `No items to group by ${aggregationLabel}.`
            : <>No items have a value for <em>{activeProperty?.name}</em>.</>}
        </div>
      </div>
    );
  }

  return (
    <div className={`chart-view ${className}`}>
      {/* Toolbar */}
      <div className="chart-view__toolbar">
        <div className="chart-view__type-toggle">
          <button
            className={`chart-view__type-btn ${chartType === 'bar' ? 'chart-view__type-btn--active' : ''}`}
            onClick={() => setChartType('bar')}
            type="button"
          >
            <Icon path="mdi mdi-chart-bar" size={0.7} />
            Bar
          </button>
          <button
            className={`chart-view__type-btn ${chartType === 'pie' ? 'chart-view__type-btn--active' : ''}`}
            onClick={() => setChartType('pie')}
            type="button"
          >
            <Icon path="mdi mdi-chart-pie" size={0.7} />
            Pie
          </button>
        </div>

        {/* Property selector (only for client-side grouping) */}
        {!hasBackendAggregation && (
          <div className="chart-view__property-select">
            <span className="chart-view__property-label">Group by</span>
            <select
              value={selectedPropertyUuid ?? ''}
              onChange={(e) => setSelectedPropertyUuid(e.target.value || undefined)}
              className="chart-view__property-dropdown"
            >
              <option value="">Select property...</option>
              {allProperties.map((p) => (
                <option key={p.uuid} value={p.uuid}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {hasBackendAggregation && aggregationLabel && (
          <div className="chart-view__property-select">
            <span className="chart-view__property-label">Grouped by</span>
            <span className="chart-view__property-value">{aggregationLabel}</span>
          </div>
        )}
      </div>

      {/* Chart */}
      <div className="chart-view__canvas">
        {chartType === 'bar' ? (
          <BarChart data={chartData} onBarClick={handleBarClick} />
        ) : (
          <PieChart data={chartData} onSliceClick={handleBarClick} />
        )}
      </div>

      {/* Legend */}
      <div className="chart-view__legend">
        {chartData.map((d) => (
          <div key={d.label} className="chart-view__legend-item">
            <span className="chart-view__legend-color" style={{ backgroundColor: d.color }} />
            <span className="chart-view__legend-label">{d.label}</span>
            <span className="chart-view__legend-count">({d.count})</span>
          </div>
        ))}
      </div>
    </div>
  );
});

registerView({
  id: 'chart',
  label: 'Chart',
  icon: 'mdi mdi-chart-bar',
  component: ChartView,
  capabilities: { groupBy: false },
});
