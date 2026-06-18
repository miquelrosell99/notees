/**
 * CalendarView – Month/Week/Day calendar grid for NodeCollection
 *
 * Displays nodes as events on a calendar grid using start/end date properties.
 * Supports three view modes: month, week, day.
 */
import { useMemo, useState, useCallback, memo } from 'react';
import type { Node } from '@/types';
import type { NodeCalendarViewProps } from '@/types/nodeCollection';
import { useCalendarData, useCalendarDateMutation, addDays, startOfMonth, startOfWeek, isSameDay, isBeforeDay, isAfterDay } from '@/features/views';
import type { CalendarEvent } from '@/features/views';
import { PageContextMenu, BlockContextMenu } from '@/features/content';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/icons';
import { registerView } from './registry';
import './CalendarView.css';

function formatDateForApi(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const VIEW_MODE_LABELS: Record<CalendarViewMode, string> = {
  month: 'Month',
  week: 'Week',
  day: 'Day',
};

type CalendarViewMode = 'month' | 'week' | 'day';

// ==================== EventCard subcomponent ====================

interface EventCardProps {
  ev: CalendarEvent;
  day: Date;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContextMenu: (node: Node, x: number, y: number) => void;
  onDragStart: (ev: CalendarEvent) => void;
}

const EventCard = memo(function EventCard({
  ev,
  day,
  onNodeClick,
  onNodeShiftClick,
  onContextMenu,
  onDragStart,
}: EventCardProps) {
  const isFirstDay = isSameDay(ev.startDate, day);
  const isLastDay = ev.endDate ? isSameDay(ev.endDate, day) : isSameDay(ev.startDate, day);
  const isMultiDay = ev.endDate && !isSameDay(ev.startDate, ev.endDate);

  return (
    <button
      type="button"
      className={`calendar-view__event ${isMultiDay ? 'calendar-view__event--multi' : ''} ${
        isFirstDay ? 'calendar-view__event--first' : ''
      } ${isLastDay ? 'calendar-view__event--last' : ''}`}
      draggable
      onDragStart={() => onDragStart(ev)}
      onClick={(e) => {
        e.stopPropagation();
        if (e.shiftKey) onNodeShiftClick?.(ev.node);
        else onNodeClick?.(ev.node);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(ev.node, e.clientX, e.clientY);
      }}
      title={`${ev.node.name || 'Untitled'}${ev.endDate ? ` (${formatDateForApi(ev.startDate)} → ${formatDateForApi(ev.endDate)})` : ''}`}
    >
      <span className="calendar-view__event-dot" />
      <span className="calendar-view__event-name">
        {isFirstDay || !isMultiDay ? ev.node.name || 'Untitled' : '\u00A0'}
      </span>
    </button>
  );
});

// ==================== CalendarView ====================

export const CalendarView = memo(function CalendarView({
  nodes,
  startDateProperty,
  endDateProperty,
  onNodeClick,
  onNodeShiftClick,
  onAdd,
  className = '',
}: NodeCalendarViewProps) {
  const [viewMode, setViewMode] = useState<CalendarViewMode>('month');
  const [currentDate, setCurrentDate] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [dragEvent, setDragEvent] = useState<CalendarEvent | null>(null);
  const [contextMenu, setContextMenu] = useState<{ node: Node; x: number; y: number } | null>(null);

  const { events, isLoading } = useCalendarData(nodes, startDateProperty, endDateProperty);
  const { mutate: persistDate } = useCalendarDateMutation(startDateProperty);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  // Navigation helpers
  const handlePrev = useCallback(() => {
    setCurrentDate((prev) => {
      if (viewMode === 'month') return new Date(prev.getFullYear(), prev.getMonth() - 1, 1);
      if (viewMode === 'week') return addDays(prev, -7);
      return addDays(prev, -1);
    });
  }, [viewMode]);

  const handleNext = useCallback(() => {
    setCurrentDate((prev) => {
      if (viewMode === 'month') return new Date(prev.getFullYear(), prev.getMonth() + 1, 1);
      if (viewMode === 'week') return addDays(prev, 7);
      return addDays(prev, 1);
    });
  }, [viewMode]);

  const handleToday = useCallback(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    setCurrentDate(d);
  }, []);

  // Period label
  const periodLabel = useMemo(() => {
    if (viewMode === 'month') {
      return currentDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
    if (viewMode === 'week') {
      const weekStart = startOfWeek(currentDate);
      const weekEnd = addDays(weekStart, 6);
      const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
      if (sameMonth) {
        return `${weekStart.toLocaleDateString(undefined, { month: 'long' })} ${weekStart.getDate()} – ${weekEnd.getDate()}, ${weekStart.getFullYear()}`;
      }
      const sameYear = weekStart.getFullYear() === weekEnd.getFullYear();
      if (sameYear) {
        return `${weekStart.toLocaleDateString(undefined, { month: 'short' })} ${weekStart.getDate()} – ${weekEnd.toLocaleDateString(undefined, { month: 'short' })} ${weekEnd.getDate()}, ${weekStart.getFullYear()}`;
      }
      return `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} – ${weekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    return currentDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }, [currentDate, viewMode]);

  const getEventsForDay = useCallback(
    (day: Date): CalendarEvent[] => {
      return events.filter((ev) => {
        const s = ev.startDate;
        const e = ev.endDate ?? ev.startDate;
        return (
          (isSameDay(s, day) || isBeforeDay(s, day)) &&
          (isSameDay(e, day) || isAfterDay(e, day))
        );
      });
    },
    [events]
  );

  const handleDragStart = useCallback((ev: CalendarEvent) => {
    setDragEvent(ev);
  }, []);

  const handleDropOnDay = useCallback(
    (day: Date) => {
      if (!dragEvent) return;
      if (!isSameDay(dragEvent.startDate, day)) {
        persistDate({ nodeId: dragEvent.node.id, newDate: day });
      }
      setDragEvent(null);
    },
    [dragEvent, persistDate]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleContextMenu = useCallback((node: Node, x: number, y: number) => {
    setContextMenu({ node, x, y });
  }, []);

  // Build month grid
  const calendarWeeks = useMemo(() => {
    const start = startOfMonth(currentDate);
    const end = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
    const startDayOfWeek = start.getDay();

    const days: Date[] = [];
    for (let i = startDayOfWeek; i > 0; i--) {
      days.push(addDays(start, -i));
    }
    const daysInMonth = end.getDate();
    for (let i = 0; i < daysInMonth; i++) {
      days.push(addDays(start, i));
    }
    const remaining = (7 - (days.length % 7)) % 7;
    for (let i = 1; i <= remaining; i++) {
      days.push(addDays(end, i));
    }

    const weeks: Date[][] = [];
    for (let i = 0; i < days.length; i += 7) {
      weeks.push(days.slice(i, i + 7));
    }
    return weeks;
  }, [currentDate]);

  // Build week grid
  const weekDays = useMemo(() => {
    const start = startOfWeek(currentDate);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [currentDate]);

  // Empty states
  if (!startDateProperty) {
    return (
      <div className={`calendar-view calendar-view--empty ${className}`}>
        <div className="calendar-view__empty-msg">
          Choose a start date property to see events on the calendar.
        </div>
      </div>
    );
  }

  if (events.length === 0 && !isLoading) {
    return (
      <div className={`calendar-view calendar-view--empty ${className}`}>
        <div className="calendar-view__header">
          <div className="calendar-view__nav">
            <Button variant="ghost" size="sm" icon="mdi mdi-chevron-left" aria-label="Previous month" className="calendar-view__nav-btn" onClick={handlePrev} />
            <span className="calendar-view__month-label">{periodLabel}</span>
            <Button variant="ghost" size="sm" icon="mdi mdi-chevron-right" aria-label="Next month" className="calendar-view__nav-btn" onClick={handleNext} />
          </div>
          <button className="calendar-view__today-btn" onClick={handleToday} type="button">
            Today
          </button>
        </div>
        <div className="calendar-view__empty-msg">
          No items have a date in <em>{startDateProperty.name}</em>.
        </div>
      </div>
    );
  }

  // Render a single day cell
  const renderDayCell = (day: Date, isCurrentPeriod: boolean, classNameSuffix = '') => {
    const isToday = isSameDay(day, today);
    const dayEvents = getEventsForDay(day);
    const hasEvents = dayEvents.length > 0;

    return (
      <div
        key={day.toISOString()}
        className={`calendar-view__day ${isCurrentPeriod ? 'calendar-view__day--current-period' : 'calendar-view__day--other-period'} ${
          isToday ? 'calendar-view__day--today' : ''
        } ${hasEvents ? 'calendar-view__day--has-events' : ''} ${classNameSuffix}`}
        onDragOver={handleDragOver}
        onDrop={() => handleDropOnDay(day)}
      >
        <div className="calendar-view__day-header">
          <span className="calendar-view__day-number">{day.getDate()}</span>
          {viewMode !== 'month' && (
            <span className="calendar-view__day-weekday">{WEEKDAYS[day.getDay()]}</span>
          )}
          {!hasEvents && onAdd && (
            <button
              className="calendar-view__day-add hover-reveal icon-only-touch-target"
              onClick={(e) => {
                e.stopPropagation();
                onAdd();
              }}
              aria-label={`Add event on ${formatDateForApi(day)}`}
              title={`Add event on ${formatDateForApi(day)}`}
              type="button"
            >
              <Icon path="mdi mdi-plus" size={0.6} />
            </button>
          )}
        </div>
        <div className="calendar-view__day-events">
          {dayEvents.map((ev) => (
            <EventCard
              key={ev.node.id}
              ev={ev}
              day={day}
              onNodeClick={onNodeClick}
              onNodeShiftClick={onNodeShiftClick}
              onContextMenu={handleContextMenu}
              onDragStart={handleDragStart}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className={`calendar-view ${className}`}>
      {/* Header */}
      <div className="calendar-view__header">
        <div className="calendar-view__nav">
          <Button variant="ghost" size="sm" icon="mdi mdi-chevron-left" aria-label="Previous month" className="calendar-view__nav-btn" onClick={handlePrev} title="Previous" />
          <span className="calendar-view__month-label">{periodLabel}</span>
          <Button variant="ghost" size="sm" icon="mdi mdi-chevron-right" aria-label="Next month" className="calendar-view__nav-btn" onClick={handleNext} title="Next" />
        </div>
        <div className="calendar-view__controls">
          {/* View mode toggle */}
          <div className="calendar-view__view-toggle" role="group" aria-label="View mode">
            {(['month', 'week', 'day'] as CalendarViewMode[]).map((mode) => (
              <button
                key={mode}
                className={`calendar-view__view-btn ${viewMode === mode ? 'calendar-view__view-btn--active' : ''}`}
                onClick={() => setViewMode(mode)}
                type="button"
                aria-pressed={viewMode === mode}
              >
                {VIEW_MODE_LABELS[mode]}
              </button>
            ))}
          </div>
          <button className="calendar-view__today-btn" onClick={handleToday} type="button">
            Today
          </button>
        </div>
      </div>

      {/* Weekday headers (month & week) */}
      {viewMode !== 'day' && (
        <div className="calendar-view__weekdays">
          {WEEKDAYS.map((day) => (
            <div key={day} className="calendar-view__weekday">
              {day}
            </div>
          ))}
        </div>
      )}

      {/* Grid */}
      {viewMode === 'month' && (
        <div className="calendar-view__grid">
          {calendarWeeks.map((week) =>
            week.map((day) => renderDayCell(day, day.getMonth() === currentDate.getMonth()))
          )}
        </div>
      )}

      {viewMode === 'week' && (
        <div className="calendar-view__grid calendar-view__grid--week">
          {weekDays.map((day) => renderDayCell(day, true, 'calendar-view__day--week'))}
        </div>
      )}

      {viewMode === 'day' && (
        <div className="calendar-view__grid calendar-view__grid--day">
          {renderDayCell(currentDate, true, 'calendar-view__day--day')}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        contextMenu.node.is_page ? (
          <PageContextMenu
            node={contextMenu.node}
            position={{ x: contextMenu.x, y: contextMenu.y }}
            onClose={() => setContextMenu(null)}
          />
        ) : (
          <BlockContextMenu
            node={contextMenu.node}
            position={{ x: contextMenu.x, y: contextMenu.y }}
            onClose={() => setContextMenu(null)}
          />
        )
      )}
    </div>
  );
});

registerView({
  id: 'calendar',
  label: 'Calendar',
  icon: 'mdi mdi-calendar-month',
  component: CalendarView,
  capabilities: { groupBy: false, ganttConfig: true },
});
