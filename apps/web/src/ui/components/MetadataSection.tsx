/**
 * MetadataSection — the page's effective-properties panel (renamed
 * "Metadata").
 *
 * Compatibility barrel: the implementation moved to the metadata
 * feature folder (`src/features/metadata/`, the first folder under
 * `src/features/` — tree realignment, 2026-10-19; the folder itself
 * holds the ui/components-stage modularization history). This shim
 * keeps the historical import surface (`components/MetadataSection`)
 * working — TypeScript's bundler resolution does NOT map `dir.js` →
 * `dir/index.ts`, so the shim file is load-bearing. The panel's own
 * stylesheet keeps loading through this file's side-effect import.
 *
 * The folder module's layout (each unit carries its doc comment):
 *  - `shared.ts` — the client union, the minimal-editor text round-trip,
 *    node-ref/asset/class resolution, the contrast pick;
 *  - `datetimeValue.ts` — the datetime union's slot decomposition + ISO
 *    readers; `propertyGroups.ts` — the section's rows model + the
 *    emptiness count;
 *  - the property rows (one element per file): PropertySelectCell,
 *    ObjectPropertyRow (+ ObjectPropertyPill), AssetPropertyRow (+
 *    AssetItemRow), DatetimePropertyRow, SelectPropertyRow,
 *    BooleanPropertyRow, GroupedPropertyRow, ScalarPropertyValue,
 *    QualifierRange;
 *  - the identity/add rows: ClassesRow, TagsRow, AliasesRow,
 *    AddPropertyRow;
 *  - the composers: PropertiesTable, PropertiesSection (the block
 *    panel), PropertiesSidebar (the page column), PropertySettingsModal.
 *
 * The nt-* class hooks the tests assert on (.nt-properties-panel,
 * .nt-property-*, .nt-classes-row, …) are unchanged.
 */

import "./MetadataSection.css";

export {
  AliasesRow,
  ClassesRow,
  metadataRowCount,
  PropertiesSection,
  PropertiesSidebar,
  PropertiesTable,
  TagsRow,
} from "../../features/metadata/index.js";
