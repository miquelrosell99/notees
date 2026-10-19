/**
 * spinner.tsx — catalog Spinner, normalized (checklist contract in
 * button.tsx). The fleet register is a border-arc spinner (the registry's
 * lucide Loader2 original swapped): the arc rides the icon-size tokens,
 * spins on the 0.8s linear register, and stays a PURELY VISUAL span —
 * the role=status/aria-busy announcement is the caller's (the app wrapper
 * owns it). The reduced-motion honest cue ("…") lives in the app
 * wrapper's co-located CSS (the utility layer can't express the pseudo
 * swap).
 */
import { cn } from "@/utils/cn";

function Spinner({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 rounded-full border-thick border-solid border-outline-variant border-t-on-surface-variant motion-safe:animate-spinner-arc",
        className,
      )}
      {...props}
    />
  );
}

export { Spinner };
