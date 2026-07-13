import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '@/stores/appStore';

const resetState = () =>
  useAppStore.setState({
    contentDisplayMode: 'bullet',
    cardLayout: 'no-cover',
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
    useAppStore.getState().setContentDisplayMode('kanban');
    expect(useAppStore.getState().contentDisplayMode).toBe('kanban');
  });

  it('toggleContentDisplayMode cycles bullet → document → kanban → bullet', () => {
    expect(useAppStore.getState().contentDisplayMode).toBe('bullet');
    useAppStore.getState().toggleContentDisplayMode();
    expect(useAppStore.getState().contentDisplayMode).toBe('document');
    useAppStore.getState().toggleContentDisplayMode();
    expect(useAppStore.getState().contentDisplayMode).toBe('kanban');
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
