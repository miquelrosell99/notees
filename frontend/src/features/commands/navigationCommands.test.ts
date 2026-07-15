import { describe, it, expect } from 'vitest';
import { useCommandRegistry, COMMAND_IDS } from '@/stores/commandRegistry';
import '@/features/commands/navigationCommands';

describe('navigationCommands palette registrations', () => {
  it('registers exactly one "Open Tasks" command, targeting the dedicated tasks view', () => {
    const openTasks = useCommandRegistry
      .getState()
      .getPaletteCommands()
      .filter((c) => c.label === 'Open Tasks');
    expect(openTasks).toHaveLength(1);
    expect(openTasks[0]?.id).toBe(COMMAND_IDS.OPEN_TASKS_VIEW);
  });

  it('does not register the legacy ad-hoc tasks collection command', () => {
    expect(useCommandRegistry.getState().getCommand('nav.tasks')).toBeUndefined();
  });
});
