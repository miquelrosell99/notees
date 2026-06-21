/**
 * Shared plugin-system types.
 */

import type { PluginContext } from './PluginContext';

export type PluginSetupFunction = (context: PluginContext) => void | Promise<void>;
