/**
 * input.tsx — catalog Input, normalized (see button.tsx for the checklist
 * contract): theme keys only, focus ring from --ring, fleet radii.
 */
import * as React from "react";

import { cn } from "@/utils/cn";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-button-md w-full rounded-input border border-input bg-transparent px-3 text-base text-on-surface transition-colors duration-short ease-standard placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
