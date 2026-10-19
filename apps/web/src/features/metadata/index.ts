/**
 * The metadata feature — the page's effective-properties panel (renamed
 * "Metadata"). First folder under `src/features/`
 * (tree realignment, 2026-10-19): moved verbatim from
 * `ui/components/metadata/` (the ui/components stage of the
 * modularization pipeline), with the public import surface re-homed
 * here. The panel's stylesheet is co-located and loads through this
 * barrel's side-effect import (the old compat shim that carried it,
 * `ui/components/MetadataSection.tsx`, is deleted).
 */

import "./MetadataSection.css";

export { ClassesRow } from "./ClassesRow.js";
export { TagsRow } from "./TagsRow.js";
export { AliasesRow } from "./AliasesRow.js";
export { metadataRowCount } from "./propertyGroups.js";
export { PropertiesTable } from "./PropertiesTable.js";
export { PropertiesSection } from "./PropertiesSection.js";
export { PropertiesSidebar } from "./PropertiesSidebar.js";
