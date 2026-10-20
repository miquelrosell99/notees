/**
 * The metadata feature — the page's effective-properties panel (renamed
 * "Metadata", owner 2026-10-09). First folder under `src/features/`
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
// The property-definition surfaces (owner ruling 2026-10-20): the S1
// pre-creation modal + its app-level host (features open it with
// initialName / initialType / contextClassId; the host owns the
// module-level request queue the slash command, the Ctrl/Cmd+Alt+P chord,
// and the verb create-and-bind fire), and the S4 client-side eligibility
// walk (the add-property candidate gating).
export { PropertyCreateModal } from "./PropertyCreateModal.js";
export type { PropertyCreateModalProps } from "./PropertyCreateModal.js";
export { PropertyCreateHost, requestPropertyCreate } from "./PropertyCreateHost.js";
export type { PropertyCreateRequest } from "./PropertyCreateHost.js";
export {
  classClosureOf,
  isSchemaEligibleForNode,
  eligibleSchemasForNode,
} from "./schemaEligibility.js";
