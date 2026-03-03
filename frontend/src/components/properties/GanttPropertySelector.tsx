/**
 * GanttPropertySelector Component
 *
 * A panel for selecting start and end date properties for Gantt view.
 * Only shows properties of type 'date'.
 */
import { useMemo } from 'react';
import { useProperties } from '@/hooks';
import type { Property } from '@/types';
import { mdiCalendarStart, mdiCalendarEnd } from '@mdi/js';
import Icon from '@mdi/react';
import './GanttPropertySelector.css';

export interface GanttPropertySelectorProps {
  /** Currently selected start date property */
  startDateProperty?: Property;
  /** Currently selected end date property */
  endDateProperty?: Property;
  /** Callback when start date property changes */
  onStartDatePropertyChange: (property: Property | undefined) => void;
  /** Callback when end date property changes */
  onEndDatePropertyChange: (property: Property | undefined) => void;
}

/**
 * GanttPropertySelector - Select start and end date properties for Gantt view
 */
export function GanttPropertySelector({
  startDateProperty,
  endDateProperty,
  onStartDatePropertyChange,
  onEndDatePropertyChange,
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
        <div className="gantt-property-selector__loading">Loading properties…</div>
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
      {renderPropertyList('Start date', mdiCalendarStart, startDateProperty, onStartDatePropertyChange)}
      <div className="gantt-property-selector__divider" />
      {renderPropertyList('End date', mdiCalendarEnd, endDateProperty, onEndDatePropertyChange)}
    </div>
  );
}
