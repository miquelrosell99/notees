/**
 * skeleton.tsx — catalog Skeleton, normalized (checklist contract in
 * button.tsx).
 */
import * as React from "react";

import { cn } from "@/utils/cn";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-item bg-surface-container-high", className)}
      {...props}
    />
  );
}

export { Skeleton };
