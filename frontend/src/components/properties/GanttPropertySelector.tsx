/**
 * GanttPropertySelector Component
 *
 * Configuration panel for Gantt view:
 * - Select start and end date properties (only date-type shown)
 * - Select time scale (day / week / month)
 */
import { useMemo } from 'react';
import { useProperties } from '@/hooks';
import { Spinner } from '@/components/core/Spinner';
import type { Property } from '@/types';

import './GanttPropertySelector.css';
import { Icon } from '@/components/core/icons';

export type GanttTimeScale = 'day' | 'week' | 'month';

const TIME_SCALE_OPTIONS: { value: GanttTimeScale; label: string }[] = [
  { value: 'day',   label: 'Day'   },
  { value: 'week',  label: 'Week'  },
  { value: 'month', label: 'Month' },
];

export interface GanttPropertySelectorProps {
  /** Currently selected start date property */
  startDateProperty?: Property;
  /** Currently selected end date property */
  endDateProperty?: Property;
  /** Callback when start date property changes */
  onStartDatePropertyChange: (property: Property | undefined) => void;
  /** Callback when end date property changes */
  onEndDatePropertyChange: (property: Property | undefined) => void;
  /** Currently active time scale */
  timeScale?: GanttTimeScale;
  /** Callback when time scale changes */
  onTimeScaleChange?: (scale: GanttTimeScale) => void;
}

/**
 * GanttPropertySelector - Select start/end date properties and time scale for Gantt view
 */
export function GanttPropertySelector({
  startDateProperty,
  endDateProperty,
  onStartDatePropertyChange,
  onEndDatePropertyChange,
  timeScale = 'week',
  onTimeScaleChange,
}: GanttPropertySelectorProps) {
  const { data: allProperties = [], isLoading } = useProperties();

  // Only show date-type properties
  const dateProperties = useMemo(
    () => allProperties.filter((p) => p.type === 'date'),
    [allProperties]
  );

  if (isLoading) {
    return (
      <div className="gantt-property-selector">
        <div className="gantt-property-selector__loading"><Spinner size="sm" label="Loading properties…" /></div>
      </div>
    );
  }

  if (dateProperties.length === 0) {
    return (
      <div className="gantt-property-selector">
        <div className="gantt-property-selector__empty">
          No date properties found. Create a date-type property first.
        </div>
      </div>
    );
  }

  const renderPropertyList = (
    label: string,
    icon: string,
    selected: Property | undefined,
    onChange: (p: Property | undefined) => void
  ) => (
    <div className="gantt-property-selector__section">
      <div className="gantt-property-selector__section-header">
        <Icon path={icon} size={0.7} />
        <span>{label}</span>
      </div>
      <div className="gantt-property-selector__list">
        {/* None option */}
        <button
          className={`gantt-property-selector__item ${!selected ? 'gantt-property-selector__item--active' : ''}`}
          onClick={() => onChange(undefined)}
        >
          <span className="gantt-property-selector__item-name">None</span>
        </button>
        {dateProperties.map((prop) => (
          <button
            key={prop.id}
            className={`gantt-property-selector__item ${selected?.id === prop.id ? 'gantt-property-selector__item--active' : ''}`}
            onClick={() => onChange(prop)}
          >
            {prop.icon && <Icon path={prop.icon} size={0.6} />}
            <span className="gantt-property-selector__item-name">{prop.name}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="gantt-property-selector">
      {/* Time scale */}
      {onTimeScaleChange && (
        <>
          <div className="gantt-property-selector__section">
            <div className="gantt-property-selector__section-header">
              <Icon path={"mdi mdi-calendar-range"} size={0.7} />
              <span>Time scale</span>
            </div>
            <div className="gantt-property-selector__scale-row">
              {TIME_SCALE_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  className={`gantt-property-selector__scale-btn ${timeScale === value ? 'gantt-property-selector__scale-btn--active' : ''}`}
                  onClick={() => onTimeScaleChange(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="gantt-property-selector__divider" />
        </>
      )}

      {renderPropertyList('Start date', "mdi mdi-calendar-start", startDateProperty, onStartDatePropertyChange)}
      <div className="gantt-property-selector__divider" />
      {renderPropertyList('End date', "mdi mdi-calendar-end", endDateProperty, onEndDatePropertyChange)}
    </div>
  );
}
