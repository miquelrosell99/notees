import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '@/stores/appStore';

const resetState = () =>
  useAppStore.setState({
    contentDisplayMode: 'bullet',
    cardLayout: 'no-cover',
    nodeViewModes: {},
    nodeGroupBy: {},
    ganttTimeScale: 'week',
  });

beforeEach(resetState);

describe('appStore — content display mode', () => {
  it('defaults to bullet', () => {
    expect(useAppStore.getState().contentDisplayMode).toBe('bullet');
  });

  it('setContentDisplayMode updates mode', () => {
    useAppStore.getState().setContentDisplayMode('document');
    expect(useAppStore.getState().contentDisplayMode).toBe('document');
    useAppStore.getState().setContentDisplayMode('card');
    expect(useAppStore.getState().contentDisplayMode).toBe('card');
  });

  it('toggleContentDisplayMode cycles bullet → document → card → bullet', () => {
    expect(useAppStore.getState().contentDisplayMode).toBe('bullet');
    useAppStore.getState().toggleContentDisplayMode();
    expect(useAppStore.getState().contentDisplayMode).toBe('document');
    useAppStore.getState().toggleContentDisplayMode();
    expect(useAppStore.getState().contentDisplayMode).toBe('card');
    useAppStore.getState().toggleContentDisplayMode();
    expect(useAppStore.getState().contentDisplayMode).toBe('bullet');
  });
});

describe('appStore — card layout', () => {
  it('defaults to no-cover', () => {
    expect(useAppStore.getState().cardLayout).toBe('no-cover');
  });

  it('setCardLayout updates layout', () => {
    useAppStore.getState().setCardLayout('cover-top');
    expect(useAppStore.getState().cardLayout).toBe('cover-top');
  });
});

describe('appStore — node view modes', () => {
  it('setNodeViewMode stores mode keyed by nodeId+viewType', () => {
    useAppStore.getState().setNodeViewMode(1, 'children', 'list');
    expect(useAppStore.getState().getNodeViewMode(1, 'children')).toBe('list');
  });

  it('getNodeViewMode returns undefined for unknown key', () => {
    expect(useAppStore.getState().getNodeViewMode(999, 'unknown')).toBeUndefined();
  });

  it('setNodeViewMode does not overwrite other keys', () => {
    useAppStore.getState().setNodeViewMode(1, 'children', 'list');
    useAppStore.getState().setNodeViewMode(2, 'children', 'card');
    expect(useAppStore.getState().getNodeViewMode(1, 'children')).toBe('list');
    expect(useAppStore.getState().getNodeViewMode(2, 'children')).toBe('card');
  });
});

describe('appStore — node group by', () => {
  it('setNodeGroupBy stores groupBy keyed by nodeId+viewType', () => {
    useAppStore.getState().setNodeGroupBy(1, 'children', 'type');
    expect(useAppStore.getState().getNodeGroupBy(1, 'children')).toBe('type');
  });

  it('getNodeGroupBy returns undefined for unknown key', () => {
    expect(useAppStore.getState().getNodeGroupBy(999, 'children')).toBeUndefined();
  });
});

describe('appStore — gantt settings', () => {
  it('setGanttTimeScale updates ganttTimeScale', () => {
    useAppStore.getState().setGanttTimeScale('month');
    expect(useAppStore.getState().ganttTimeScale).toBe('month');
  });

  it('setGanttStartDatePropertyUuid updates the uuid', () => {
    useAppStore.getState().setGanttStartDatePropertyUuid('custom-uuid');
    expect(useAppStore.getState().ganttStartDatePropertyUuid).toBe('custom-uuid');
  });

  it('setGanttEndDatePropertyUuid updates the uuid', () => {
    useAppStore.getState().setGanttEndDatePropertyUuid('end-uuid');
    expect(useAppStore.getState().ganttEndDatePropertyUuid).toBe('end-uuid');
  });
});
