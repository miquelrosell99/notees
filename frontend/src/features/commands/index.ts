/**
 * Commands feature
 *
 * Registers all palette-visible commands. Importing this module at app startup
 * ensures static command registrations are executed before the command palette
 * is first rendered.
 */

// Static registrations (no React hooks required)
import './navigationCommands';
import './viewCommands';
import './pageCommands';
import './importExportCommands';
import './devCommands';

// React hook-based registrations
export { CommandRegistrations } from './components/CommandRegistrations';
