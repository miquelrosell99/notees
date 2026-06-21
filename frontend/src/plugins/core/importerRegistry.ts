/**
 * Frontend registry for plugin-contributed importers.
 *
 * Mirrors the backend importer registry so the import modal can show
 * plugin-owned sources without hardcoding them.
 */

export interface ImporterDefinition {
  id: string;
  label: string;
  fileExtensions?: string[];
  pluginId: string;
}

const importerRegistry = new Map<string, ImporterDefinition>();

export function registerImporter(def: ImporterDefinition): void {
  importerRegistry.set(def.id, def);
}

export function unregisterImporter(id: string): void {
  importerRegistry.delete(id);
}

export function getImporter(id: string): ImporterDefinition | undefined {
  return importerRegistry.get(id);
}

export function getRegisteredImporters(): ImporterDefinition[] {
  return Array.from(importerRegistry.values());
}
