/**
 * switch.tsx — catalog Switch (Radix), normalized (checklist contract in
 * button.tsx). The fleet wrapper (src/ui/components/ui/ToggleSwitch.tsx)
 * composes this with the dual-label A/B register.
 */
import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/utils/cn";

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    className={cn(
      "inline-flex h-height-md w-12 shrink-0 cursor-pointer items-center rounded-full border border-outline-variant bg-surface-container-high transition-colors duration-short ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed data-[state=checked]:bg-primary data-[state=checked]:border-primary",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "block h-icon-sm w-icon-sm translate-x-micro rounded-full bg-on-surface-variant transition-transform duration-short ease-standard data-[state=checked]:translate-x-6 data-[state=checked]:bg-on-primary",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

export { Switch };
