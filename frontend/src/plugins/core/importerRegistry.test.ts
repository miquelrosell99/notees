import { describe, it, expect } from 'vitest';
import {
  registerImporter,
  unregisterImporter,
  getImporter,
  getRegisteredImporters,
} from './importerRegistry';

describe('importerRegistry', () => {
  it('registers and unregisters importers', () => {
    const def = { id: 'bibtex', label: 'BibTeX', fileExtensions: ['bib'], pluginId: 'notees.bibtex' };

    registerImporter(def);
    expect(getImporter('bibtex')).toBe(def);
    expect(getRegisteredImporters()).toContain(def);

    unregisterImporter('bibtex');
    expect(getImporter('bibtex')).toBeUndefined();
    expect(getRegisteredImporters()).not.toContain(def);
  });

  it('lists multiple importers', () => {
    const a = { id: 'a', label: 'A', pluginId: 'p.a' };
    const b = { id: 'b', label: 'B', pluginId: 'p.b' };
    registerImporter(a);
    registerImporter(b);

    const list = getRegisteredImporters();
    expect(list).toHaveLength(2);
    expect(list.map((i) => i.id).sort()).toEqual(['a', 'b']);

    unregisterImporter('a');
    unregisterImporter('b');
  });
});
