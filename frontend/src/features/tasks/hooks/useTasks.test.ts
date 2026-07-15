/**
 * useTasks tests — query tabs must request node properties.
 *
 * Query-driven views only render task-status badges when the backend response
 * carries node properties; without include_properties the runtime projection
 * never learns taskStatus for query results.
 */
import { describe, it, expect } from 'vitest';
import { getQueryForTab } from './useTasks';

describe('getQueryForTab', () => {
  it.each(['all', 'today', 'future'] as const)('requests properties for the %s tab', (tab) => {
    expect(getQueryForTab(tab).include_properties).toBe(true);
  });
});
