/**
 * ChartView - Configurable chart visualization for nodes
 * 
 * Supports bar, line, pie, donut, area, and scatter charts.
 * Can group by a property and show node count or aggregate a number property.
 */
import { useState, useMemo } from 'react';
import './ChartView.css';
import type { Node, Property } from '@/types/api';
import type { 
  ChartType, 
  ChartNumberSource, 
  ChartAggregation, 
  ChartDataPoint,
  ChartViewConfig 
} from '@/types/views';

export interface ChartViewProps {
  /** Nodes to visualize */
  nodes: Node[];
  /** Available properties */
  properties?: Property[];
  /** Initial config */
  config?: Partial<ChartViewConfig>;
  /** Callback when config changes */
  onConfigChange?: (config: ChartViewConfig) => void;
  /** Callback when a data point is clicked */
  onDataPointClick?: (nodes: Node[]) => void;
  /** Extra CSS class */
  className?: string;
  /** Title */
  title?: string;
}

const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: 'bar', label: 'Bar' },
  { value: 'line', label: 'Line' },
  { value: 'pie', label: 'Pie' },
  { value: 'donut', label: 'Donut' },
  { value: 'area', label: 'Area' },
  { value: 'scatter', label: 'Scatter' },
];

const AGGREGATIONS: { value: ChartAggregation; label: string }[] = [
  { value: 'count', label: 'Count' },
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
];

const DEFAULT_COLORS = [
  '#525252', '#737373', '#a3a3a3', '#d4d4d4', '#404040', '#262626',
];

/**
 * Get property value from node
 */
function getPropertyValue(node: Node, propertyId: number, properties: Property[]): unknown {
  const prop = properties.find(p => p.id === propertyId);
  if (!prop || !node.properties) return null;
  
  const propKey = prop.name.toLowerCase().replace(/\s+/g, '_');
  return (node.properties as Record<string, unknown>)[propKey] ?? null;
}

/**
 * Get groupable properties (text, selection, boolean, date)
 */
function getGroupableProperties(properties: Property[]): Property[] {
  return properties.filter(p => 
    p.type === 'text' || p.type === 'selection' || p.type === 'boolean' || p.type === 'date'
  );
}

/**
 * Get number properties (integer, float)
 */
function getNumberProperties(properties: Property[]): Property[] {
  return properties.filter(p => p.type === 'integer' || p.type === 'float');
}

/**
 * Group nodes by property and compute values
 */
function computeChartData(
  nodes: Node[],
  groupByPropertyId: number | null,
  numberSource: ChartNumberSource,
  aggregation: ChartAggregation,
  properties: Property[]
): ChartDataPoint[] {
  const groups = new Map<string, Node[]>();
  
  // Group nodes
  for (const node of nodes) {
    let label = 'All';
    if (groupByPropertyId) {
      const value = getPropertyValue(node, groupByPropertyId, properties);
      label = value === null || value === undefined 
        ? 'Ungrouped' 
        : typeof value === 'boolean' 
          ? (value ? 'Yes' : 'No')
          : String(value);
    }
    const existing = groups.get(label) ?? [];
    existing.push(node);
    groups.set(label, existing);
  }
  
  // Compute values for each group
  const data: ChartDataPoint[] = [];
  let colorIndex = 0;
  
  for (const [label, groupNodes] of groups.entries()) {
    let value: number;
    
    if (numberSource.type === 'count') {
      value = groupNodes.length;
    } else {
      const propertyId = numberSource.propertyId;
      const values = groupNodes
        .map(n => {
          const v = getPropertyValue(n, propertyId, properties);
          return typeof v === 'number' ? v : parseFloat(String(v));
        })
        .filter(v => !isNaN(v));
      
      switch (aggregation) {
        case 'sum':
          value = values.reduce((a, b) => a + b, 0);
          break;
        case 'avg':
          value = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
          break;
        case 'min':
          value = values.length > 0 ? Math.min(...values) : 0;
          break;
        case 'max':
          value = values.length > 0 ? Math.max(...values) : 0;
          break;
        case 'count':
        default:
          value = groupNodes.length;
      }
    }
    
    data.push({
      label,
      value,
      nodes: groupNodes,
      color: DEFAULT_COLORS[colorIndex % DEFAULT_COLORS.length],
    });
    colorIndex++;
  }
  
  // Sort by label (Ungrouped last)
  return data.sort((a, b) => {
    if (a.label === 'Ungrouped') return 1;
    if (b.label === 'Ungrouped') return -1;
    return a.label.localeCompare(b.label);
  });
}

/**
 * Bar/Line/Area Chart (SVG)
 */
function BarChart({ 
  data, 
  chartType,
  showLabels,
  onDataPointClick 
}: { 
  data: ChartDataPoint[]; 
  chartType: 'bar' | 'line' | 'area';
  showLabels: boolean;
  onDataPointClick?: (nodes: Node[]) => void;
}) {
  const maxValue = Math.max(...data.map(d => d.value), 1);
  const width = 400;
  const height = 200;
  const padding = { top: 20, right: 20, bottom: 40, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  const barWidth = Math.max(chartWidth / data.length - 4, 10);
  const xScale = (i: number) => padding.left + (i * chartWidth / data.length) + barWidth / 2;
  const yScale = (v: number) => padding.top + chartHeight - (v / maxValue * chartHeight);
  
  if (chartType === 'bar') {
    return (
      <svg className="chart-view__svg" viewBox={`0 0 ${width} ${height}`}>
        {/* Y axis */}
        <line 
          x1={padding.left} y1={padding.top} 
          x2={padding.left} y2={height - padding.bottom}
          stroke="var(--color-outline-variant)"
        />
        {/* X axis */}
        <line 
          x1={padding.left} y1={height - padding.bottom}
          x2={width - padding.right} y2={height - padding.bottom}
          stroke="var(--color-outline-variant)"
        />
        {/* Bars */}
        {data.map((d, i) => (
          <g key={d.label}>
            <rect
              x={xScale(i) - barWidth / 2 + 2}
              y={yScale(d.value)}
              width={barWidth - 4}
              height={chartHeight - (yScale(d.value) - padding.top)}
              fill={d.color}
              className="chart-view__bar"
              onClick={() => onDataPointClick?.(d.nodes)}
            />
            {showLabels && (
              <>
                <text
                  x={xScale(i)}
                  y={height - padding.bottom + 15}
                  textAnchor="middle"
                  className="chart-view__label"
                >
                  {d.label.length > 8 ? d.label.slice(0, 8) + '…' : d.label}
                </text>
                <text
                  x={xScale(i)}
                  y={yScale(d.value) - 5}
                  textAnchor="middle"
                  className="chart-view__value"
                >
                  {d.value}
                </text>
              </>
            )}
          </g>
        ))}
      </svg>
    );
  }
  
  // Line/Area chart
  const points = data.map((d, i) => `${xScale(i)},${yScale(d.value)}`).join(' ');
  const areaPoints = `${padding.left},${height - padding.bottom} ${points} ${xScale(data.length - 1)},${height - padding.bottom}`;
  
  return (
    <svg className="chart-view__svg" viewBox={`0 0 ${width} ${height}`}>
      {/* Y axis */}
      <line 
        x1={padding.left} y1={padding.top} 
        x2={padding.left} y2={height - padding.bottom}
        stroke="var(--color-outline-variant)"
      />
      {/* X axis */}
      <line 
        x1={padding.left} y1={height - padding.bottom}
        x2={width - padding.right} y2={height - padding.bottom}
        stroke="var(--color-outline-variant)"
      />
      {/* Area fill */}
      {chartType === 'area' && (
        <polygon
          points={areaPoints}
          fill="var(--color-primary)"
          fillOpacity="0.2"
        />
      )}
      {/* Line */}
      <polyline
        points={points}
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="2"
      />
      {/* Points */}
      {data.map((d, i) => (
        <g key={d.label}>
          <circle
            cx={xScale(i)}
            cy={yScale(d.value)}
            r="4"
            fill="var(--color-primary)"
            className="chart-view__point"
            onClick={() => onDataPointClick?.(d.nodes)}
          />
          {showLabels && (
            <text
              x={xScale(i)}
              y={height - padding.bottom + 15}
              textAnchor="middle"
              className="chart-view__label"
            >
              {d.label.length > 8 ? d.label.slice(0, 8) + '…' : d.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/**
 * Pie/Donut Chart (SVG)
 */
function PieChart({ 
  data, 
  isDonut,
  showLabels,
  onDataPointClick 
}: { 
  data: ChartDataPoint[]; 
  isDonut: boolean;
  showLabels: boolean;
  onDataPointClick?: (nodes: Node[]) => void;
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const size = 200;
  const center = size / 2;
  const radius = size * 0.4;
  const innerRadius = isDonut ? radius * 0.6 : 0;
  
  let startAngle = -Math.PI / 2;
  
  const slices = data.map((d) => {
    const angle = (d.value / total) * Math.PI * 2;
    const endAngle = startAngle + angle;
    
    const x1 = center + radius * Math.cos(startAngle);
    const y1 = center + radius * Math.sin(startAngle);
    const x2 = center + radius * Math.cos(endAngle);
    const y2 = center + radius * Math.sin(endAngle);
    
    const ix1 = center + innerRadius * Math.cos(startAngle);
    const iy1 = center + innerRadius * Math.sin(startAngle);
    const ix2 = center + innerRadius * Math.cos(endAngle);
    const iy2 = center + innerRadius * Math.sin(endAngle);
    
    const largeArc = angle > Math.PI ? 1 : 0;
    
    const path = isDonut
      ? `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix1} ${iy1} Z`
      : `M ${center} ${center} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    
    const labelAngle = startAngle + angle / 2;
    const labelRadius = isDonut ? (radius + innerRadius) / 2 : radius * 0.65;
    const labelX = center + labelRadius * Math.cos(labelAngle);
    const labelY = center + labelRadius * Math.sin(labelAngle);
    
    startAngle = endAngle;
    
    return { d, path, labelX, labelY, percent: (d.value / total * 100).toFixed(0) };
  });
  
  return (
    <svg className="chart-view__svg" viewBox={`0 0 ${size} ${size}`}>
      {slices.map(({ d, path, labelX, labelY, percent }) => (
        <g key={d.label}>
          <path
            d={path}
            fill={d.color}
            className="chart-view__slice"
            onClick={() => onDataPointClick?.(d.nodes)}
          />
          {showLabels && parseFloat(percent) > 5 && (
            <text
              x={labelX}
              y={labelY}
              textAnchor="middle"
              dominantBaseline="middle"
              className="chart-view__pie-label"
            >
              {percent}%
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/**
 * Legend component
 */
function Legend({ data }: { data: ChartDataPoint[] }) {
  return (
    <div className="chart-view__legend">
      {data.map(d => (
        <div key={d.label} className="chart-view__legend-item">
          <span 
            className="chart-view__legend-color" 
            style={{ backgroundColor: d.color }}
          />
          <span className="chart-view__legend-label">{d.label}</span>
          <span className="chart-view__legend-value">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * ChartView Component
 */
export function ChartView({
  nodes,
  properties = [],
  config: initialConfig,
  onConfigChange,
  onDataPointClick,
  className = '',
  title = 'Chart',
}: ChartViewProps) {
  const [chartType, setChartType] = useState<ChartType>(initialConfig?.chartType ?? 'bar');
  const [groupByPropertyId, setGroupByPropertyId] = useState<number | null>(
    initialConfig?.groupByPropertyId ?? null
  );
  const [numberSource, setNumberSource] = useState<ChartNumberSource>(
    initialConfig?.numberSource ?? { type: 'count' }
  );
  const [aggregation, setAggregation] = useState<ChartAggregation>(
    initialConfig?.aggregation ?? 'count'
  );
  const [showLabels] = useState(initialConfig?.showLabels ?? true);
  const [showLegend] = useState(initialConfig?.showLegend ?? true);
  
  const groupableProps = useMemo(() => getGroupableProperties(properties), [properties]);
  const numberProps = useMemo(() => getNumberProperties(properties), [properties]);
  
  const chartData = useMemo(
    () => computeChartData(nodes, groupByPropertyId, numberSource, aggregation, properties),
    [nodes, groupByPropertyId, numberSource, aggregation, properties]
  );
  
  const handleChartTypeChange = (type: ChartType) => {
    setChartType(type);
    onConfigChange?.({
      mode: 'chart',
      chartType: type,
      groupByPropertyId,
      numberSource,
      aggregation,
      showLabels,
      showLegend,
    });
  };
  
  const handleGroupByChange = (propertyId: number | null) => {
    setGroupByPropertyId(propertyId);
    onConfigChange?.({
      mode: 'chart',
      chartType,
      groupByPropertyId: propertyId,
      numberSource,
      aggregation,
      showLabels,
      showLegend,
    });
  };
  
  const handleNumberSourceChange = (source: ChartNumberSource) => {
    setNumberSource(source);
    onConfigChange?.({
      mode: 'chart',
      chartType,
      groupByPropertyId,
      numberSource: source,
      aggregation,
      showLabels,
      showLegend,
    });
  };
  
  if (nodes.length === 0) {
    return (
      <div className={`chart-view chart-view--empty ${className}`}>
        <p className="chart-view__empty">No data to display</p>
      </div>
    );
  }
  
  return (
    <div className={`chart-view ${className}`}>
      <div className="chart-view__header">
        <h3 className="chart-view__title">{title}</h3>
        <div className="chart-view__controls">
          {/* Chart type */}
          <select 
            className="chart-view__select"
            value={chartType}
            onChange={(e) => handleChartTypeChange(e.target.value as ChartType)}
          >
            {CHART_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          
          {/* Group by */}
          {groupableProps.length > 0 && (
            <select
              className="chart-view__select"
              value={groupByPropertyId ?? ''}
              onChange={(e) => handleGroupByChange(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">No grouping</option>
              {groupableProps.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
          
          {/* Number source */}
          <select
            className="chart-view__select"
            value={numberSource.type === 'count' ? 'count' : `prop-${numberSource.propertyId}`}
            onChange={(e) => {
              const val = e.target.value;
              if (val === 'count') {
                handleNumberSourceChange({ type: 'count' });
              } else {
                const propId = Number(val.replace('prop-', ''));
                handleNumberSourceChange({ type: 'property', propertyId: propId });
              }
            }}
          >
            <option value="count">Count</option>
            {numberProps.map(p => (
              <option key={p.id} value={`prop-${p.id}`}>{p.name}</option>
            ))}
          </select>
          
          {/* Aggregation (when using property) */}
          {numberSource.type === 'property' && (
            <select
              className="chart-view__select"
              value={aggregation}
              onChange={(e) => setAggregation(e.target.value as ChartAggregation)}
            >
              {AGGREGATIONS.filter(a => a.value !== 'count').map(a => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>
          )}
        </div>
      </div>
      
      <div className="chart-view__content">
        <div className="chart-view__chart">
          {(chartType === 'bar' || chartType === 'line' || chartType === 'area') && (
            <BarChart 
              data={chartData} 
              chartType={chartType}
              showLabels={showLabels}
              onDataPointClick={onDataPointClick}
            />
          )}
          {(chartType === 'pie' || chartType === 'donut') && (
            <PieChart 
              data={chartData} 
              isDonut={chartType === 'donut'}
              showLabels={showLabels}
              onDataPointClick={onDataPointClick}
            />
          )}
          {chartType === 'scatter' && (
            <BarChart 
              data={chartData} 
              chartType="line"
              showLabels={showLabels}
              onDataPointClick={onDataPointClick}
            />
          )}
        </div>
        
        {showLegend && <Legend data={chartData} />}
      </div>
    </div>
  );
}

export default ChartView;
