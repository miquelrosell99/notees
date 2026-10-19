/**
 * label.tsx — catalog Label (Radix), normalized (checklist contract in
 * button.tsx).
 */
import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "@/utils/cn";

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      "text-sm font-semibold leading-none text-on-surface-variant select-none peer-disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Label.displayName = "Label";

export { Label };
