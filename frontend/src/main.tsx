/*
 * Notees
 * Copyright (C) 2026 Miquel Rosell Tarragó
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * See the LICENSE file for details.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './variables.css'
import './styles/data-colors.css'
import './index.css'
import { App } from './App.tsx'
import { useSettingsStore, applyTheme, applyAccentColor } from './stores'
import { useUIStateStore } from './features/sync'

// Apply saved theme and accent on startup — wrapped in try/catch so a corrupt
// store never prevents the app from mounting at all.
try {
  const { theme, accentColor, customAccentHex } = useSettingsStore.getState();
  applyTheme(theme);
  applyAccentColor(accentColor, customAccentHex);
} catch (e) {
  console.error('[main] Failed to apply saved theme/accent, falling back to default:', e);
}

// Restore local UI state from previous session.
useUIStateStore.getState().load().catch((e) => {
  console.error('[main] Failed to restore UI state:', e);
});

// Catch errors that escape React's error boundary (async callbacks, event
// handlers, etc.) and log them so they surface in the browser console /
// crash-reporter rather than silently producing a white screen.
window.addEventListener('error', (event) => {
  console.error('[main] Uncaught error:', event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[main] Unhandled promise rejection:', event.reason);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
