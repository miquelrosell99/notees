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

  // Demo node action: appears in the page/block context menu and in inline
  // node/class link menus. devOnly keeps it hidden unless dev options are on.
  context.registerNodeAction({
    id: 'hello.logNodeUuid',
    label: 'Hello: Log node UUID',
    icon: 'mdi-hand-wave-outline',
    devOnly: true,
    execute: ({ nodeUuid }) => {
      log.info(`Hello plugin node action: ${nodeUuid}`);
    },
  });
}
