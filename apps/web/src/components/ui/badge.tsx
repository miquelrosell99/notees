/**
 * badge.tsx — catalog Badge, normalized (checklist contract in button.tsx).
 * Fleet radii: the count-badge pill rides --radius-badge (9px).
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/utils/cn";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-badge border gap-1 whitespace-nowrap font-semibold transition-colors duration-short ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  {
    variants: {
      variant: {
        default:
          "bg-primary-container text-on-primary-container border-transparent",
        secondary:
          "bg-secondary text-secondary-foreground border-transparent",
        outline:
          "bg-transparent text-on-surface-variant border-outline-variant",
        destructive:
          "bg-error-container text-on-error-container border-transparent",
        success:
          "bg-success-container text-on-success-container border-transparent",
      },
      size: {
        default: "h-icon-sm px-1 text-2xs",
        sm: "h-icon-xs px-micro text-3xs",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant, size }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
