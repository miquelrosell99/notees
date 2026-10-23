/**
 * ClassMultiPickField — the class multi-picker the property-definition
 * modals share: the selected classes render as pills (icon + name + remove),
 * an "Add class" SelectTrigger anchors the NodeSelector in classes mode.
 * Used for the targetClassFilter (object/asset/datetime schemas) and the
 * scopeClassIds list (local scope) — pure composition over the fleet kit.
 */

import { useRef, useState } from "react";

import { Icon } from "../../ui/Icon.js";
import { SelectTrigger } from "../../components/ui/fleet/SelectTrigger.js";
import { NodeSelector } from "../pickers/NodeSelector.js";
import { labelFromClient } from "../../ui/dateDisplay.js";
import type { AnyClient } from "./shared.js";

export function ClassMultiPickField({
  client,
  classIds,
  onChange,
  addLabel = "Add class",
  ariaLabel,
}: {
  client: AnyClient;
  classIds: string[];
  onChange: (classIds: string[]) => void;
  addLabel?: string;
  ariaLabel: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);

  return (
    <div className="nt-class-pick">
      {classIds.length > 0 && (
        <ul className="nt-class-pick__pills">
          {classIds.map((classId) => {
            // Never a bare UUID (owner 2026-10-23) — archived classes keep
            // their name; a permanently deleted class reads the placeholder.
            const label = labelFromClient(client, classId) ?? "Deleted class";
            const icon = client.getNode(classId)?.icon;
            return (
              <li key={classId} className="pill">
                {icon !== null && icon !== undefined && icon !== "" && (
                  <span className="pill__left-icon">
                    <Icon path={icon} size={0.7} />
                  </span>
                )}
                <span className="pill__text">{label}</span>
                <button
                  type="button"
                  className="pill__right-button"
                  aria-label={`Remove ${label}`}
                  onClick={() => onChange(classIds.filter((id) => id !== classId))}
                >
                  <Icon path="mdi-close" size={0.6} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div ref={triggerRef}>
        <SelectTrigger
          isOpen={pickerOpen}
          onClick={() => setPickerOpen((open) => !open)}
          ariaLabel={ariaLabel}
        >
          <span className="select-trigger__placeholder">{addLabel}</span>
        </SelectTrigger>
      </div>
      {pickerOpen && triggerRef.current !== null && (
        <NodeSelector
          client={client}
          searchMode="classes"
          anchorEl={triggerRef.current}
          searchPlaceholder="Search classes"
          onClose={() => setPickerOpen(false)}
          onAdd={(node) => {
            if (!classIds.includes(node.id)) onChange([...classIds, node.id]);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** The modal-local "field" wrapper: label above control (the settings
 *  register). A div, NOT a label — a label would swallow its interactive
 *  children's accessible names (the Convert… row-button became "Type
 *  object"); the inputs carry their own aria-labels. */
export function PropertyField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="nt-property-settings__field">
      <span className="nt-property-settings__label">{label}</span>
      {children}
    </div>
  );
}

/** A row-level icon trigger (the option/class icon picker anchor). The
 *  color rides resolved (cssColorFor) — the Icon takes a concrete value. */
export function IconTriggerButton({
  icon,
  color,
  label,
  onClick,
  buttonRef,
}: {
  icon: string | null;
  color?: string | null;
  label: string;
  onClick: (anchor: HTMLElement) => void;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="nt-property-settings__option-icon"
      title={label}
      aria-label={label}
      onClick={(event) => onClick(event.currentTarget)}
    >
      {icon !== null && icon !== "" ? (
        <Icon path={icon} size={0.7} {...(color ? { color } : {})} />
      ) : (
        <Icon path="mdi-plus-circle-outline" size={0.7} />
      )}
    </button>
  );
}
