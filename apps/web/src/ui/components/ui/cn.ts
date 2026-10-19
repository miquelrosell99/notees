/**
 * Class name utility — re-exports the app-wide cn (src/utils/cn).
 *
 * Historical home of the joiner (the app's CSS-only layer predates the
 * shadcn bridge); kept so the dozens of relative `./cn` imports keep
 * working. New code imports from `@/utils/cn`.
 */
export { cn, type ClassValue } from "../../../utils/cn.js";
