/**
 * slider.tsx — catalog Slider (Radix), normalized (checklist contract in
 * button.tsx). The fleet register: a 4px track on outline-variant with
 * the primary fill, a token-sized thumb (the icon-xs canvas, the
 * surface ring, the 1.15 hover grow) and the fleet focus ring. The md
 * size is the default; sm rides the --slider-thumb-size-sm thumb and the
 * --spacing-tiny track (the graph settings register).
 */
import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/utils/cn";

const sliderVariants = cva("relative flex w-full touch-none select-none items-center", {
  variants: {
    size: {
      sm: "",
      md: "",
    },
  },
  defaultVariants: { size: "md" },
});

const TRACK_CLASSES: Record<"sm" | "md", string> = {
  sm: "h-tiny",
  md: "h-shape-sm",
};

const THUMB_CLASSES: Record<"sm" | "md", string> = {
  sm: "h-slider-thumb-sm w-slider-thumb-sm",
  md: "h-icon-xs w-icon-xs",
};

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> &
    VariantProps<typeof sliderVariants> & { "aria-label"?: string | undefined }
>(({ className, size = "md", "aria-label": ariaLabel, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(sliderVariants({ size }), className)}
    {...props}
  >
    <SliderPrimitive.Track
      className={cn(
        "relative w-full grow overflow-hidden rounded-full bg-outline-variant",
        TRACK_CLASSES[size ?? "md"],
      )}
    >
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      aria-label={ariaLabel}
      className={cn(
        "block rounded-full border-thick border-solid border-surface bg-primary transition-[transform,background-color] duration-short ease-standard",
        "hover:scale-thumb-grow focus-visible:outline-none focus-visible:outline-offset-micro focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-40",
        THUMB_CLASSES[size ?? "md"],
      )}
    />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
