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
import './index.css'
import App from './App.tsx'
import { useSettingsStore, applyTheme } from './stores'

// Apply saved theme on startup
const savedTheme = useSettingsStore.getState().theme;
applyTheme(savedTheme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
