/**
 * button.tsx — the shadcn catalog Button, normalized to the fleet tokens
 * (rosellramos-design-system → components/shadcn-bridge.md checklist):
 * theme-key utilities only, fleet radii, hover = state-layer overlay via
 * the --accent alias, focus ring from --ring (never suppressed), chrome
 * icons on the fleet Icon primitive (no lucide).
 *
 * The app's own Button (src/components/ui/fleet/Button.tsx) is the thin fleet
 * wrapper composing this — the fleet variants (default/primary/outline/
 * ghost/danger/danger-solid), sizes, MDI icons, badges, haptics, and the
 * loading register live there. This module is the catalog layer: new code
 * that needs a plain catalog button composes from here.
 */
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/utils/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-button border font-sans font-medium select-none transition-colors duration-short ease-standard active:scale-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground border-primary hover:bg-primary-hover",
        secondary:
          "bg-secondary text-secondary-foreground border-secondary hover:bg-surface-container-high",
        outline:
          "bg-transparent border-input text-on-surface-variant hover:bg-accent hover:text-accent-foreground hover:border-outline",
        ghost:
          "bg-transparent border-transparent text-on-surface-variant hover:bg-accent hover:text-accent-foreground",
        destructive:
          "bg-destructive text-destructive-foreground border-destructive hover:bg-error-hover",
        link: "border-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-button-md px-3 text-button",
        sm: "h-button-sm px-2 text-sm rounded-button-sm",
        lg: "h-button-lg px-4 text-base",
        icon: "h-button-md w-button-md",
        "icon-sm": "h-button-sm w-button-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
