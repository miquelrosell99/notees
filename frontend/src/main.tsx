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

// Temporary instrumentation to identify the component causing the
// "Maximum update depth exceeded" loop. It monkey-patches console.error
// so the JS call stack at the first occurrence is captured, and adds
// React 19 root error callbacks so we get the React component stack too.
function installReactLoopInstrumentation(): void {
  const originalError = console.error;
  let alreadyLogged = false;

  console.error = (...args: unknown[]) => {
    originalError(...args);

    const text = args
      .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : ''))
      .join(' ');

    if (text.includes('Maximum update depth exceeded') && !alreadyLogged) {
      alreadyLogged = true;
      originalError(
        '[main] Maximum update depth exceeded call stack:',
        new Error('Maximum update depth exceeded').stack,
      );
    }
  };
}

installReactLoopInstrumentation();

function hideSplash(): void {
  (window as unknown as { __hideNoteesSplash?: () => void }).__hideNoteesSplash?.();
}

function showFatalError(message: string): void {
  hideSplash();
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div style="padding:24px;color:#fff;background:#121211;min-height:100vh;font-family:system-ui,sans-serif;">
      <h1 style="font-size:20px;margin-bottom:12px;">Failed to start Notees</h1>
      <p style="opacity:0.8;margin-bottom:16px;">${message}</p>
      <button onclick="window.location.reload()" style="padding:8px 16px;background:#fff;color:#121211;border:none;border-radius:4px;cursor:pointer;">Reload page</button>
    </div>`;
  }
}

// Defensive timeout: if the splash is still visible after 8 seconds, something
// prevented React from mounting (a top-level exception, a hung import, etc.).
// Hide the splash and show a readable error instead of leaving the user stuck.
const splashFallbackTimer = window.setTimeout(() => {
  showFatalError('The app took too long to initialize. Check the browser console for errors and try reloading.');
}, 8000);

try {
  const root = createRoot(
    document.getElementById('root')!,
    // Temporary instrumentation: capture component stacks for React errors.
    {
      onUncaughtError(error: Error, errorInfo: { componentStack?: string }) {
        console.error('[main] React uncaught error:', error, errorInfo.componentStack);
      },
      onCaughtError(error: Error, errorInfo: { componentStack?: string }) {
        console.error('[main] React caught error:', error, errorInfo.componentStack);
      },
    } as unknown as Parameters<typeof createRoot>[1],
  );
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (err) {
  window.clearTimeout(splashFallbackTimer);
  console.error('[main] Fatal error mounting React:', err);
  showFatalError(
    `A fatal error prevented the app from starting: ${err instanceof Error ? err.message : String(err)}`
  );
}

// Remove the static splash screen once React has mounted so it never outlives
// a failed workspace load or an auth/onboarding state.
requestAnimationFrame(() => {
  window.clearTimeout(splashFallbackTimer);
  hideSplash();
});
