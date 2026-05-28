/**
 * View Field System
 *
 * Unified field/column definition that all tabular/grid views can consume.
 * Replaces ad-hoc column definitions in TableView, CardView, etc.
 */
import type { ReactNode } from 'react';
import type { Node, Property } from './api';

export type ViewFieldType = 'name' | 'property' | 'virtual' | 'classes' | 'created' | 'modified';

export interface ViewField {
  /** Unique identifier (property uuid or virtual key like '__classes__') */
  id: string;
  /** Field type category */
  type: ViewFieldType;
  /** Display label */
  label: string;
  /** Column width hint (for table views) */
  width?: string;
  /** Whether the field is visible */
  visible: boolean;
  /** Whether the field is sortable */
  sortable?: boolean;
  /** For property fields: the property definition */
  property?: Property;
  /** Custom render function (optional) */
  render?: (node: Node) => ReactNode;
}

export interface ViewSchema {
  fields: ViewField[];
  sort: { fieldId: string; direction: 'asc' | 'desc' }[];
  groupBy?: string;
}

/** Virtual field IDs used across views */
export const VIRTUAL_FIELD_IDS = {
  classes: '__classes__',
  created: '__created__',
  modified: '__modified__',
} as const;

/**
 * Build ViewField definitions from a list of property UUIDs.
 * Automatically includes virtual fields for classes, created, modified.
 */
export function buildViewFields(
  propertyUuids: string[],
  allProperties: Property[],
): ViewField[] {
  const fields: ViewField[] = [
    { id: 'name', type: 'name', label: 'Name', visible: true, sortable: true },
  ];

  for (const uuid of propertyUuids) {
    if (uuid === VIRTUAL_FIELD_IDS.classes) {
      fields.push({ id: uuid, type: 'classes', label: 'Classes', visible: true, width: '200px' });
    } else if (uuid === VIRTUAL_FIELD_IDS.created) {
      fields.push({ id: uuid, type: 'created', label: 'Created', visible: true, width: '150px', sortable: true });
    } else if (uuid === VIRTUAL_FIELD_IDS.modified) {
      fields.push({ id: uuid, type: 'modified', label: 'Modified', visible: true, width: '150px', sortable: true });
    } else {
      const prop = allProperties.find((p) => p.uuid === uuid);
      if (prop) {
        fields.push({
          id: uuid,
          type: 'property',
          label: prop.name,
          visible: true,
          width: '150px',
          property: prop,
        });
      }
    }
  }

  return fields;
}
