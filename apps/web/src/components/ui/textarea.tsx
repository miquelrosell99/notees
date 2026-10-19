/**
 * textarea.tsx — catalog Textarea, normalized (checklist contract in
 * button.tsx).
 */
import * as React from "react";

import { cn } from "@/utils/cn";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-button-lg w-full rounded-input border border-input bg-transparent px-3 py-2 text-base text-on-surface transition-colors duration-short ease-standard placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
