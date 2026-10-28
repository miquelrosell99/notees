/**
 * PropertyScopeControl — the scope field the definition modals share
 *: global is the default (the schema may be
 * carried by any node); "local to classes" reveals the class multi-picker
 * (a non-empty list = local to those classes AND their extends-ancestors;
 * the empty list is rejected — exactly one spelling of global).
 *
 * Controlled: the parent owns the state (the create modal stages it into
 * the create payload; the edit modal writes update {scopeClassIds}, where
 * null = global).
 */

import { ToggleSwitch } from "../../components/ui/kit/ToggleSwitch.js";
import { ClassMultiPickField, PropertyField } from "./ClassMultiPickField.js";
import type { AnyClient } from "./shared.js";

export function PropertyScopeControl({
  client,
  local,
  classIds,
  onLocalChange,
  onClassIdsChange,
}: {
  client: AnyClient;
  /** false = global (the default); true = local to `classIds`. */
  local: boolean;
  classIds: string[];
  onLocalChange: (local: boolean) => void;
  onClassIdsChange: (classIds: string[]) => void;
}) {
  return (
    <PropertyField label="Scope">
      <ToggleSwitch
        id="property-scope"
        size="sm"
        leftLabel="Global (any node)"
        rightLabel="Local to classes"
        checked={local}
        onChange={(value) => {
          onLocalChange(value);
          // Turning local on with no classes yet: seed nothing — the
          // picker below owns the list (the empty list is rejected at
          // the wire, so Create stays disabled until one is picked).
        }}
        aria-label="Property scope"
      />
      {local && (
        <ClassMultiPickField
          client={client}
          classIds={classIds}
          onChange={onClassIdsChange}
          addLabel="Add scope class"
          ariaLabel="Scope classes"
        />
      )}
    </PropertyField>
  );
}
