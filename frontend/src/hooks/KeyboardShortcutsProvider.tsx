import { useGlobalKeyboardListener } from './useGlobalKeyboardListener';

/**
 * Provider component that sets up global keyboard handling
 */
export function KeyboardShortcutsProvider({ children }: { children: React.ReactNode }) {
  useGlobalKeyboardListener();
  return <>{children}</>;
}
