/**
 * BrokenLinkFixContext — provides a callback to fix broken links by creating a node.
 *
 * Used by ContextMenuPlugin (inside Lexical editors) to open the
 * create-node-with-UUID modal with the missing UUID pre-filled.
 */
import { createContext, useContext } from 'react';

export type FixBrokenLinkCallback = (uuid: string) => void;

export const BrokenLinkFixContext = createContext<FixBrokenLinkCallback | null>(null);

export function useBrokenLinkFix(): FixBrokenLinkCallback | null {
  return useContext(BrokenLinkFixContext);
}
