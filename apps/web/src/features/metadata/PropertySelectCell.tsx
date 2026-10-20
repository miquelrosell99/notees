import { type KeyboardEvent, type ReactNode } from "react";

import type { AnyClient } from "./shared.js";
import { Icon } from "../../ui/Icon.js";

/**
 * PropertySelectCell — the single-value selection control (owner 2026-10-09):
 * a full-width dropdown trigger whose content shows the selected value
 * compactly — a node renders as ONE pill (the shared NodePill element,
 * tinted with the effective color; never a subtree, never editable chrome),
 * a date renders its display name; an empty cell renders the muted "Select"
 * placeholder so the empty value still reads as a field spanning the value
 * cell. The owner popup (node picker / date picker) anchors at the trigger;
 * the clear affordance unsets the authored slot; trailing chrome (repeat
 * picker, link qualifiers, asset annotations) rides beside it. The trigger
 * is a div[role=button], not a native button: the content area hosts the
 * pill, which a <button> could not legally wrap.
 */
export function PropertySelectCell({
  client,
  /** The selected node's id; null renders the placeholder. */
  valueRef,
  ariaLabel,
  placeholder = "Select",
  isOpen,
  /** The trigger hands its element to the parent (the popup anchors at it). */
  onToggle,
  clearLabel,
  onClear,
  /** Trailing chrome beside the trigger (repeat picker, qualifier range). */
  trailing,
  /**
   * The navigate action (owner 2026-10-20): with a value set, the → button
   * renders inside the trigger beside the chevron — the value click keeps
   * owning the picker, the button owns navigation (the table's pinned Open
   * button idiom).
   */
  onNavigate,
  navigateLabel,
  /** The selected value's content — one pill, or the date's display name. */
  children,
}: {
  client: AnyClient;
  valueRef: string | null;
  ariaLabel: string;
  placeholder?: string;
  isOpen: boolean;
  onToggle: (anchor: HTMLElement) => void;
  clearLabel: string;
  onClear: (() => void) | undefined;
  trailing?: ReactNode;
  onNavigate?: (() => void) | undefined;
  navigateLabel?: string | undefined;
  children?: ReactNode;
}) {
  const linkedNode = valueRef !== null ? client.getNode(valueRef) : undefined;
  const open = (anchor: HTMLElement) => onToggle(anchor);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(event.currentTarget);
    }
  };
  return (
    <div className="nt-property-select">
      <div
        role="button"
        tabIndex={0}
        className="nt-property-select__trigger"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        onClick={(event) => open(event.currentTarget)}
        onKeyDown={onKeyDown}
      >
        <div className="nt-property-select__content">
          {valueRef === null ? (
            <span className="nt-property-select__placeholder">{placeholder}</span>
          ) : linkedNode === undefined ? (
            // PB1 honest broken reference: the raw id, never a silent void.
            <span
              className="nt-property-select__broken"
              title={`Broken reference: ${valueRef}`}
            >
              <code>{valueRef}</code>
            </span>
          ) : (
            children
          )}
        </div>
        {onNavigate !== undefined && valueRef !== null && (
          <button
            type="button"
            className="nt-property-select__nav"
            title={navigateLabel}
            aria-label={navigateLabel}
            onClick={(event) => {
              // The trigger's click owns the picker — the button owns
              // navigation (owner 2026-10-20).
              event.stopPropagation();
              onNavigate();
            }}
          >
            <Icon path="mdi-arrow-right" size={0.7} />
          </button>
        )}
        <span className="nt-property-select__chevron" aria-hidden="true">
          <Icon path="mdi-chevron-down" size={0.7} />
        </span>
      </div>
      {onClear !== undefined && valueRef !== null && (
        <button
          type="button"
          className="nt-property-select__clear"
          aria-label={clearLabel}
          onClick={onClear}
        >
          ×
        </button>
      )}
      {trailing}
    </div>
  );
}
