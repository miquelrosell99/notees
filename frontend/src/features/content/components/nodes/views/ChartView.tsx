/**
 * ChartView – Bar, line and pie chart aggregation view for NodeCollection.
 *
 * Groups nodes by a selected dimension and renders an aggregated measure as an
 * SVG chart. The view calls the backend aggregation endpoint when a NodeView ID
 * is available, otherwise it falls back to client-side grouping by property.
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
  value: number;
  color: string;
}

const CHART_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

const BUILTIN_DIMENSIONS: { value: string; label: string; property_type?: 'date' | 'checkbox' }[] = [
  { value: 'is_page', label: 'page type' },
  { value: 'create_date', label: 'create date', property_type: 'date' },
  { value: 'write_date', label: 'write date', property_type: 'date' },
  { value: 'open_date', label: 'open date', property_type: 'date' },
];

const MEASURE_FUNCTIONS: { value: 'sum' | 'avg' | 'min' | 'max'; label: string }[] = [
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' },
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
    .map(([label, value], i) => ({
      label,
      value,
      color: CHART_COLORS[i % CHART_COLORS.length],
    }));
  return sorted;
}

function buildChartDataFromGroups(groups: QueryGroupResult[]): ChartDatum[] {
  return groups
    .filter(g => g.value != null)
    .map((g, i) => ({
      label: String(g.dim_0 ?? g.group_key ?? '(No value)'),
      value: Number(g.value),
      color: CHART_COLORS[i % CHART_COLORS.length],
    }));
}

function findPropertyType(uuid: string, properties: Property[]) {
  const prop = properties.find(p => p.uuid === uuid);
  if (!prop) return undefined;
  // Map API property type to QueryAST property type.
  const typeMap: Record<string, string> = {
    text: 'text',
    number: 'number',
    date: 'date',
    checkbox: 'checkbox',
    select: 'select',
    multi_select: 'multi_select',
    node: 'node',
    url: 'url',
    email: 'email',
  };
  return (typeMap[prop.type] ?? prop.type) as 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'multi_select' | 'node' | 'url' | 'email';
}

// ==================== BarChart ====================

interface BarChartProps {
  data: ChartDatum[];
  onBarClick?: (label: string) => void;
}

const BarChart = memo(function BarChart({ data, onBarClick }: BarChartProps) {
  if (data.length === 0) return null;

  const maxValue = Math.max(...data.map(d => d.value));
  const chartHeight = 300;
  const chartWidth = Math.max(data.length * 80, 400);
  const barWidth = 50;
  const barGap = 30;
  const margin = { top: 20, right: 20, bottom: 80, left: 60 };
  const innerWidth = chartWidth - margin.left - margin.right;
  const innerHeight = chartHeight - margin.top - margin.bottom;

  return (
    <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="chart-view__svg">
      <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + innerHeight} stroke="var(--outline-variant)" />
      <line x1={margin.left} y1={margin.top + innerHeight} x2={margin.left + innerWidth} y2={margin.top + innerHeight} stroke="var(--outline-variant)" />

      {Array.from({ length: 5 }, (_, i) => {
        const y = margin.top + innerHeight - (i / 4) * innerHeight;
        const value = Math.round((i / 4) * maxValue);
        return (
          <g key={i}>
            <line x1={margin.left - 5} y1={y} x2={margin.left} y2={y} stroke="var(--outline-variant)" />
            <text x={margin.left - 10} y={y + 4} textAnchor="end" fontSize="10" fill="var(--on-surface-variant)">
              {value}
            </text>
          </g>
        );
      })}

      {data.map((d, i) => {
        const barHeight = maxValue > 0 ? (d.value / maxValue) * innerHeight : 0;
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
            <text x={x + barWidth / 2} y={y - 6} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--on-surface)">
              {Number.isInteger(d.value) ? d.value : d.value.toFixed(2)}
            </text>
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

// ==================== LineChart ====================

interface LineChartProps {
  data: ChartDatum[];
}

const LineChart = memo(function LineChart({ data }: LineChartProps) {
  if (data.length === 0) return null;

  const maxValue = Math.max(...data.map(d => d.value));
  const chartHeight = 300;
  const chartWidth = Math.max(data.length * 80, 400);
  const margin = { top: 20, right: 20, bottom: 80, left: 60 };
  const innerWidth = chartWidth - margin.left - margin.right;
  const innerHeight = chartHeight - margin.top - margin.bottom;
  const stepX = data.length > 1 ? innerWidth / (data.length - 1) : innerWidth / 2;

  const points = data.map((d, i) => {
    const x = margin.left + (data.length > 1 ? i * stepX : innerWidth / 2);
    const y = maxValue > 0 ? margin.top + innerHeight - (d.value / maxValue) * innerHeight : margin.top + innerHeight;
    return { x, y, value: d.value, label: d.label, color: d.color };
  });

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  return (
    <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="chart-view__svg">
      <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + innerHeight} stroke="var(--outline-variant)" />
      <line x1={margin.left} y1={margin.top + innerHeight} x2={margin.left + innerWidth} y2={margin.top + innerHeight} stroke="var(--outline-variant)" />

      {Array.from({ length: 5 }, (_, i) => {
        const y = margin.top + innerHeight - (i / 4) * innerHeight;
        const value = Math.round((i / 4) * maxValue);
        return (
          <g key={i}>
            <line x1={margin.left - 5} y1={y} x2={margin.left} y2={y} stroke="var(--outline-variant)" />
            <text x={margin.left - 10} y={y + 4} textAnchor="end" fontSize="10" fill="var(--on-surface-variant)">
              {value}
            </text>
          </g>
        );
      })}

      <path d={pathD} fill="none" stroke="var(--color-primary)" strokeWidth={2} />

      {points.map((p) => (
        <g key={p.label}>
          <circle cx={p.x} cy={p.y} r={4} fill={p.color} />
          <text x={p.x} y={p.y - 10} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--on-surface)">
            {Number.isInteger(p.value) ? p.value : p.value.toFixed(2)}
          </text>
          <text
            x={p.x}
            y={margin.top + innerHeight + 16}
            textAnchor="middle"
            fontSize="10"
            fill="var(--on-surface-variant)"
            transform={`rotate(-30, ${p.x}, ${margin.top + innerHeight + 16})`}
          >
            {p.label}
          </text>
        </g>
      ))}
    </svg>
  );
});

// ==================== PieChart ====================

interface PieChartProps {
  data: ChartDatum[];
  onSliceClick?: (label: string) => void;
}

const PieChart = memo(function PieChart({ data, onSliceClick }: PieChartProps) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const size = 280;
  const radius = size / 2 - 20;
  const center = size / 2;

  const slices = useMemo(() => {
    let currentAngle = -Math.PI / 2;
    const result: Array<ChartDatum & { path: string; labelX: number; labelY: number; showLabel: boolean }> = [];
    for (const d of data) {
      const angle = total > 0 ? (d.value / total) * 2 * Math.PI : 0;
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
      const showLabel = total > 0 && d.value / total > 0.05;
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
              {Math.round((slice.value / total) * 100)}%
            </text>
          )}
        </g>
      ))}
    </svg>
  );
});

// ==================== ChartView ====================

type ChartType = 'bar' | 'line' | 'pie';

interface MeasureConfig {
  function: 'count' | 'sum' | 'avg' | 'min' | 'max';
  field?: string;
  property_type?: 'number';
  label: string;
}

export const ChartView = memo(function ChartView({
  nodes,
  groupByProperty: groupByPropertyProp,
  onNodeClick,
  className = '',
  viewId,
  nodeUuid,
}: NodeChartViewProps) {
  const [chartType, setChartType] = useState<ChartType>('bar');
  const [groupByField, setGroupByField] = useState<string>(groupByPropertyProp?.uuid ?? '');
  const [measure, setMeasure] = useState<MeasureConfig>({ function: 'count', label: 'Count of nodes' });

  const { data: allProperties = [] } = useProperties();

  const activeProperty = useMemo(() => {
    if (groupByPropertyProp) return groupByPropertyProp;
    return allProperties.find(p => p.uuid === groupByField);
  }, [groupByPropertyProp, groupByField, allProperties]);

  const aggregation = useMemo(() => {
    const dimensions = [];
    if (groupByField) {
      const builtin = BUILTIN_DIMENSIONS.find(b => b.value === groupByField);
      dimensions.push({
        type: 'dimension' as const,
        field: groupByField,
        property_type: builtin ? builtin.property_type : findPropertyType(groupByField, allProperties),
      });
    }
    return {
      type: 'aggregation' as const,
      dimensions,
      measure: {
        type: 'measure' as const,
        function: measure.function,
        field: measure.field,
        property_type: measure.property_type,
      },
    };
  }, [groupByField, measure, allProperties]);

  const hasBackendAggregation = viewId != null && viewId > 0;

  const { data: aggregateResult, isLoading: isAggregateLoading } = useQuery({
    queryKey: ['node-view-aggregate', viewId, aggregation, nodeUuid],
    queryFn: async () => {
      if (!viewId) return null;
      return executeNodeViewQuery(viewId, {
        runtime_params: { current_node_uuid: nodeUuid },
        aggregation,
      });
    },
    enabled: hasBackendAggregation,
    staleTime: 30_000,
  });

  const chartData = useMemo(() => {
    if (aggregateResult?.groups) {
      return buildChartDataFromGroups(aggregateResult.groups);
    }
    return buildChartData(nodes, activeProperty);
  }, [aggregateResult, nodes, activeProperty]);

  const handleBarClick = useCallback((label: string) => {
    if (aggregateResult?.groups) return;
    if (!activeProperty) return;
    const propId = String(activeProperty.id);
    const match = nodes.find(n => {
      const rawValue = (n.properties as Record<string, unknown> | undefined)?.[propId] ?? null;
      return getPropertyGroupLabel(activeProperty, rawValue) === label;
    });
    if (match) onNodeClick?.(match);
  }, [nodes, activeProperty, onNodeClick, aggregateResult]);

  const dimensionOptions = useMemo(() => [
    { value: '', label: 'None (overall)' },
    ...BUILTIN_DIMENSIONS.map(b => ({ value: b.value, label: b.label })),
    ...allProperties.map(p => ({ value: p.uuid, label: p.name })),
  ], [allProperties]);

  const measureOptions = useMemo(() => {
    const options: { value: string; label: string; config: MeasureConfig }[] = [
      { value: 'count', label: 'Count of nodes', config: { function: 'count', label: 'Count of nodes' } },
    ];
    for (const prop of allProperties) {
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
  }, [allProperties]);

  const measureValue = useMemo(() => {
    if (measure.function === 'count') return 'count';
    return `${measure.function}:${measure.field}`;
  }, [measure]);

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
          <ChartTypeToggle chartType={chartType} onChange={setChartType} />
        </div>
        <div className="chart-view__empty-msg">
          No data to chart.
        </div>
      </div>
    );
  }

  return (
    <div className={`chart-view ${className}`}>
      <div className="chart-view__toolbar">
        <ChartTypeToggle chartType={chartType} onChange={setChartType} />

        <div className="chart-view__control">
          <span className="chart-view__control-label">Group by</span>
          <select
            value={groupByField}
            onChange={(e) => setGroupByField(e.target.value)}
            className="chart-view__control-select"
          >
            {dimensionOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="chart-view__control">
          <span className="chart-view__control-label">Measure</span>
          <select
            value={measureValue}
            onChange={(e) => {
              const selected = measureOptions.find(o => o.value === e.target.value);
              if (selected) setMeasure(selected.config);
            }}
            className="chart-view__control-select"
          >
            {measureOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="chart-view__canvas">
        {chartType === 'bar' && <BarChart data={chartData} onBarClick={handleBarClick} />}
        {chartType === 'line' && <LineChart data={chartData} />}
        {chartType === 'pie' && <PieChart data={chartData} onSliceClick={handleBarClick} />}
      </div>

      <div className="chart-view__legend">
        {chartData.map((d) => (
          <div key={d.label} className="chart-view__legend-item">
            <span className="chart-view__legend-color" style={{ backgroundColor: d.color }} />
            <span className="chart-view__legend-label">{d.label}</span>
            <span className="chart-view__legend-count">({Number.isInteger(d.value) ? d.value : d.value.toFixed(2)})</span>
          </div>
        ))}
      </div>
    </div>
  );
});

function ChartTypeToggle({ chartType, onChange }: { chartType: ChartType; onChange: (t: ChartType) => void }) {
  const types: { value: ChartType; icon: string; label: string }[] = [
    { value: 'bar', icon: 'mdi mdi-chart-bar', label: 'Bar' },
    { value: 'line', icon: 'mdi mdi-chart-line', label: 'Line' },
    { value: 'pie', icon: 'mdi mdi-chart-pie', label: 'Pie' },
  ];

  return (
    <div className="chart-view__type-toggle">
      {types.map(t => (
        <button
          key={t.value}
          className={`chart-view__type-btn ${chartType === t.value ? 'chart-view__type-btn--active' : ''}`}
          onClick={() => onChange(t.value)}
          type="button"
          title={t.label}
        >
          <Icon path={t.icon} size={0.7} />
          {t.label}
        </button>
      ))}
    </div>
  );
}

registerView({
  id: 'chart',
  label: 'Chart',
  icon: 'mdi mdi-chart-bar',
  component: ChartView,
  capabilities: { groupBy: false },
});
