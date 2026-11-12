/**
 * ToggleSwitch Component
 *
 * A toggle switch with labels on each side. Unlike BooleanToggle which is
 * a simple on/off switch, ToggleSwitch shows text labels on left and right
 * sides, making it ideal for A/B choices like Page/Block.
 *
 * Interaction ruling: ToggleSwitch is for
 * enabling/disabling a SETTING only — mutually-exclusive MODE/VIEW
 * switching (AND/OR, Blocks/Raw, outline/cards/table) rides the bordered
 * SelectionButton, never this.
 *
 * Thin fleet wrapper over the normalized catalog switch
 * (src/components/ui/switch.tsx — Radix underneath): the Radix Switch root
 * IS the interactive control (role=switch, aria-checked, keyboard), the
 * dual labels render inside it, and the track geometry is the app's
 * register. The calc'd track/thumb token math has no utility form (the
 * drift gate bans arbitrary values), so it rides inline styles referencing
 * the tokens — values stay token-owned.
 *
 * A11Y: the accessible name is an explicit `aria-label` when the caller
 * names the control (the state rides aria-checked; the side labels stay
 * visual) — otherwise it derives from BOTH side labels via labelledby
 * (the v1 default).
 */
import { forwardRef, type CSSProperties, type HTMLAttributes } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "./cn.js";

export type ToggleSwitchSize = "sm" | "md" | "lg";

export interface ToggleSwitchProps extends Omit<HTMLAttributes<HTMLButtonElement>, "onChange"> {
  /** Size variant */
  size?: ToggleSwitchSize;
  /** Label for the left (unchecked) state */
  leftLabel: string;
  /** Label for the right (checked) state */
  rightLabel: string;
  /** Whether the switch is in the right (checked) position */
  checked: boolean;
  /** Callback when the switch state changes */
  onChange: (checked: boolean) => void;
  /** Whether the switch is disabled */
  disabled?: boolean;
  /** Working state: interaction is blocked and the control announces
   *  `aria-busy` (the loading register — never a silent disable). */
  loading?: boolean;
}

/** Track geometry per size — the register the old ToggleSwitch CSS owned. */
const TRACK_STYLE: Record<ToggleSwitchSize, CSSProperties> = {
  sm: { width: "calc(var(--height-sm) * 1.75)", height: "var(--height-xs)" },
  md: { width: "calc(var(--height-md) * 1.6)", height: "var(--height-sm)" },
  lg: { width: "calc(var(--height-lg) * 1.45)", height: "var(--height-md)" },
};

const THUMB_SIZE: Record<ToggleSwitchSize, string> = {
  sm: "var(--icon-size-xs)",
  md: "var(--icon-size-md)",
  lg: "var(--toggle-thumb-size-lg)",
};

const THUMB_SHIFT: Record<ToggleSwitchSize, string> = {
  sm: "calc(var(--height-xs) - var(--spacing-micro))",
  md: "calc(var(--height-sm) - var(--spacing-micro))",
  lg: "calc(var(--height-md) - var(--spacing-micro))",
};

const LABEL_SIZE: Record<ToggleSwitchSize, string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
};

/**
 * ToggleSwitch - A switch with labels on both sides for A/B selection.
 */
export const ToggleSwitch = forwardRef<HTMLButtonElement, ToggleSwitchProps>(
  function ToggleSwitch(
    {
      size = "md",
      leftLabel,
      rightLabel,
      checked,
      onChange,
      disabled = false,
      loading = false,
      className = "",
      ...props
    },
    ref,
  ) {
    const leftId = `${props.id ?? "toggle"}-left`;
    const rightId = `${props.id ?? "toggle"}-right`;
    /**
     * The accessible-name contract: callers MAY name the control explicitly
     * (aria-label — "Match ALL or ANY (group logic)" style; the state rides
     * aria-checked, the side labels stay visual). Without one, the name
     * derives from BOTH side labels via labelledby (the v1 default the
     * existing call sites rely on). aria-labelledby would otherwise win
     * over aria-label, so it is only set when no explicit name arrives.
     */
    const explicitName = props["aria-label"];

    const labelClasses = (active: boolean) =>
      cn(
        "whitespace-nowrap transition-colors duration-short ease-standard",
        LABEL_SIZE[size],
        active ? "text-on-surface font-medium" : "text-on-surface-variant",
      );

    return (
      <SwitchPrimitive.Root
        ref={ref}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...(explicitName === undefined ? { "aria-labelledby": `${leftId} ${rightId}` } : {})}
        className={cn(
          "relative inline-flex items-center gap-2 select-none bg-transparent p-0 border-0 text-inherit rounded-item",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-offset-micro",
          disabled || loading ? "opacity-50 cursor-not-allowed pointer-events-none" : "cursor-pointer",
          className,
        )}
        {...props}
      >
        <span id={leftId} className={labelClasses(!checked)}>
          {leftLabel}
        </span>
        <span
          aria-hidden="true"
          className="relative inline-flex items-center shrink-0 rounded-full border border-outline-variant bg-surface-container-high transition-colors duration-short ease-standard hover:bg-hover-overlay"
          style={TRACK_STYLE[size]}
        >
          <SwitchPrimitive.Thumb
            className="block absolute rounded-full transition-transform duration-short ease-standard"
            style={{
              width: THUMB_SIZE[size],
              height: THUMB_SIZE[size],
              left: "var(--spacing-micro)",
              background: checked
                ? "var(--md-sys-color-primary)"
                : "var(--md-sys-color-on-surface-variant)",
              transform: checked ? `translateX(${THUMB_SHIFT[size]})` : undefined,
            }}
          />
        </span>
        <span id={rightId} className={labelClasses(checked)}>
          {rightLabel}
        </span>
        {/* Invisible minimum hit-area overlay (M3's 48dp floor) — the same
            contract the old .toggle-switch::after carried, as a real
            element so it needs no stylesheet. */}
        {!disabled && !loading && (
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 min-w-touch min-h-touch"
          />
        )}
      </SwitchPrimitive.Root>
    );
  },
);
