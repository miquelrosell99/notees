/**
 * BibTeX plugin frontend setup.
 */

import { getLogger } from '@/utils/logger';
import type { PluginContext } from '@/plugins/core';

const log = getLogger('bibtex-plugin');

export function setup(context: PluginContext) {
  context.registerCommand({
    id: 'bibtex.import',
    label: 'BibTeX: Import from file',
    icon: 'file-import',
    context: 'global',
    palette: { category: 'import-export' },
    execute: () => {
      log.info('BibTeX import requested');
      // TODO: open file picker and POST to plugin importer endpoint.
    },
  });
}
