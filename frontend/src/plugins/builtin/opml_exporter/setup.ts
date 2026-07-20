/**
 * OPML exporter plugin frontend setup.
 *
 * The export format is also registered declaratively from the plugin manifest
 * by the core PluginManager. This setup module exists so the built-in plugin
 * is discovered by the static loader and can add runtime-only contributions
 * later (e.g., a custom export-options panel).
 */

import type { PluginContext } from '@/plugins/core';

export function setup(_context: PluginContext) {
  // Runtime contributions can be added here when OPML gains custom options.
}
