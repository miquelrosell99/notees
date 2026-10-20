/**
 * PropertyOptionsEditor — the select/multi_select options editor the
 * definition modals share (v1 parity: add / remove / REORDER, per-option
 * icon + color). Presentational: the parent owns the options array and
 * receives whole-array changes (the create modal stages them locally; the
 * edit modal writes update {options}).
 */

import { useState } from "react";

import type { ClientPropertyOption } from "@/core/workspace-client/index.js";

import { Button } from "../../components/ui/fleet/Button.js";
import { ColorButton } from "../../components/ui/fleet/ColorButton.js";
import { cssColorFor } from "../../components/ui/fleet/colorPresets.js";
import { ListSortable } from "../../components/ui/fleet/ListSortable.js";
import { Icon } from "../../ui/Icon.js";
import { IconPickerPopup } from "../icon-picker/IconPickerPopup.js";
import { IconTriggerButton } from "./ClassMultiPickField.js";

export function PropertyOptionsEditor({
  options,
  onChange,
}: {
  options: ClientPropertyOption[];
  onChange: (options: ClientPropertyOption[]) => void;
}) {
  /** The option whose icon picker is open (+ its anchor button). */
  const [iconPickerFor, setIconPickerFor] = useState<{
    optionId: string;
    anchor: HTMLElement;
  } | null>(null);

  const patchOption = (optionId: string, patch: Partial<ClientPropertyOption>) =>
    onChange(options.map((o) => (o.id === optionId ? { ...o, ...patch } : o)));

  return (
    <div className="nt-property-settings__field">
      <span className="nt-property-settings__label">Options</span>
      {options.length > 0 && (
        <ListSortable
          className="nt-property-settings__options"
          itemClassName="nt-property-settings__option"
          items={options}
          onReorder={(fromIndex, toIndex) => {
            const next = [...options];
            const [moved] = next.splice(fromIndex, 1);
            next.splice(toIndex, 0, moved!);
            onChange(next);
          }}
          renderIcon={(option) => (
            <IconTriggerButton
              icon={option.icon ?? null}
              color={option.color ? cssColorFor(option.color) : null}
              label={`Icon for ${option.label}`}
              onClick={(anchor) => setIconPickerFor({ optionId: option.id, anchor })}
            />
          )}
          renderText={(option) => (
            <input
              key={`${option.id}:${option.label}`}
              type="text"
              className="nt-property-settings__input"
              defaultValue={option.label}
              aria-label={`Option ${option.label}`}
              onBlur={(event) => {
                const label = event.target.value.trim();
                if (label === "" || label === option.label) return;
                patchOption(option.id, { label });
              }}
            />
          )}
          renderActions={(option) => [
            <ColorButton
              key="color"
              color={option.color ?? ""}
              size="xs"
              showPicker
              showNoneOption
              aria-label={`Color for ${option.label}`}
              onColorChange={(color) => patchOption(option.id, { color })}
            />,
            <Button
              key="remove"
              variant="ghost"
              size="sm"
              aria-label={`Remove option ${option.label}`}
              onClick={() => onChange(options.filter((o) => o.id !== option.id))}
            >
              <Icon path="mdi-close" size={0.6} />
            </Button>,
          ]}
        />
      )}
      <Button
        variant="ghost"
        size="sm"
        icon="mdi mdi-plus"
        onClick={() =>
          onChange([...options, { id: crypto.randomUUID(), label: "New option" }])
        }
      >
        Add option
      </Button>
      {iconPickerFor !== null && (
        <IconPickerPopup
          value={options.find((o) => o.id === iconPickerFor.optionId)?.icon ?? ""}
          anchorEl={iconPickerFor.anchor}
          onClose={() => setIconPickerFor(null)}
          onSelect={(value) => {
            patchOption(iconPickerFor.optionId, { icon: value === "" ? null : value });
            setIconPickerFor(null);
          }}
        />
      )}
    </div>
  );
}
