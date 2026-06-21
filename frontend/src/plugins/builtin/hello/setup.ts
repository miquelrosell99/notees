/**
 * Hello plugin frontend setup.
 */

import { getLogger } from '@/utils/logger';
import type { PluginContext } from '@/plugins/core';

const log = getLogger('hello-plugin');

export function setup(context: PluginContext) {
  context.registerCommand({
    id: 'hello.greet',
    label: 'Hello: Greet',
    icon: 'hand-wave',
    context: 'global',
    palette: { category: 'tools' },
    execute: () => {
      log.info('Hello from the Notees plugin system!');
    },
  });
}
