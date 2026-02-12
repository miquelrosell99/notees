/**
 * Time Event Generation
 * 
 * Groups pages by time period and date property to create timeline events.
 */
import type { Node } from '@/types';
import type { TimeEvent, DatePropertyConfig, ZoomLevel } from '../timelineTypes';
import { formatDateUuid, normalizeDate } from './dateUtils';

export function generateTimeEvents(
  nodes: Node[],
  dateProperties: DatePropertyConfig[],
  zoomLevel: ZoomLevel,
  startDate: Date,
  endDate: Date
): TimeEvent[] {
  const events: TimeEvent[] = [];
  const visibleProperties = dateProperties.filter(p => p.visible);
  
  // Determine time granularity based on zoom
  const granularity: 'day' | 'month' | 'year' = 
    zoomLevel === 'day' || zoomLevel === 'hour' || zoomLevel === 'week' ? 'day' :
    zoomLevel === 'month' || zoomLevel === 'quarter' ? 'month' :
    'year';
  
  // Group nodes by time period and property
  const eventMap = new Map<string, { 
    timePeriod: string;
    timePeriodDate: Date;
    property: string;
    propertyConfig: DatePropertyConfig;
    nodes: Node[];
  }>();
  
  for (const node of nodes) {
    if (!node.is_page) continue;
    
    for (const propConfig of visibleProperties) {
      const dateStr = node[propConfig.property as keyof Node];
      if (!dateStr || typeof dateStr !== 'string') continue;
      
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) continue;
      
      // Get time period identifier
      const timePeriod = formatDateUuid(date, granularity);
      const key = `${timePeriod}_${propConfig.property}`;
      
      if (!eventMap.has(key)) {
        eventMap.set(key, {
          timePeriod,
          timePeriodDate: new Date(date),
          property: propConfig.property,
          propertyConfig: propConfig,
          nodes: [],
        });
      }
      
      eventMap.get(key)!.nodes.push(node);
    }
  }
  
  // Convert to TimeEvent array
  eventMap.forEach((eventData, key) => {
    const position = normalizeDate(eventData.timePeriodDate, startDate, endDate);
    
    events.push({
      id: key,
      timePeriod: eventData.timePeriod,
      timePeriodDate: eventData.timePeriodDate,
      property: eventData.property,
      propertyLabel: eventData.propertyConfig.label,
      color: eventData.propertyConfig.color,
      nodes: eventData.nodes,
      position,
      stackIndex: 0, // Will be calculated later
    });
  });
  
  // Calculate stack indices for events at same position
  const positionGroups = new Map<number, TimeEvent[]>();
  events.forEach(event => {
    const roundedPos = Math.round(event.position * 1000); // Group by rounded position
    if (!positionGroups.has(roundedPos)) {
      positionGroups.set(roundedPos, []);
    }
    positionGroups.get(roundedPos)!.push(event);
  });
  
  positionGroups.forEach(group => {
    group.forEach((event, idx) => {
      event.stackIndex = idx;
    });
  });
  
  return events;
}
