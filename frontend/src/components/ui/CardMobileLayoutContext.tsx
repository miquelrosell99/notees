/**
 * CardMobileLayoutContext
 *
 * Context that indicates whether Cards should render in mobile-layout mode
 * (full-bleed, no border radius). Consumers inside mobile layouts wrap their
 * content with the provider; Card reads it automatically.
 */
import { createContext } from 'react';

export const CardMobileLayoutContext = createContext(false);
export const CardMobileLayoutProvider = CardMobileLayoutContext.Provider;
