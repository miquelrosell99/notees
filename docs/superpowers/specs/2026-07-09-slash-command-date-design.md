# Slash Command: Date — Design

## Goal
Add a `/date` slash command to the block editor that opens a calendar popup and inserts a node link to the selected daily journal page.

## Context
- The editor already has a unified slash-command popup (`TriggerPopup`) and a plugin system for handling command selection (`InlineTriggers`).
- The existing `/date-range` command follows the same pattern: remove the `/` placeholder, close the popup, open a picker, and insert an AST node when the user confirms.
- Daily journal pages use deterministic UUIDs (`00000000-0000-00dd-YYYYMMDD0000`) and are created on demand via `getOrCreateDaily(isoDate)`.
- A reusable `DatePickerPopup` (calendar + natural-language text input) already exists in the codebase.

## Decision Log
- **Daily page creation: eager.** When a date is selected, the command calls `getOrCreateDaily` immediately so the inserted link resolves to an existing page and displays the correct date name.
- **Picker: `DatePickerPopup`.** It provides both a calendar grid and natural-language input ("today", "tomorrow", "Feb 14"), matching the behavior of date properties elsewhere in the app.
- **Insertion: `node_link` pill.** The selected date becomes a normal navigable inline link to the daily page, using the existing `insertPill` helper.

## Architecture

### Files changed
1. `frontend/src/features/editor/editor/plugins/TriggerPopup.tsx`
   - Add `{ id: 'date', label: 'Date', description: 'Insert a link to a daily journal page' }` to `SLASH_COMMANDS`.

2. `frontend/src/features/editor/custom/plugins/InlineTriggers.tsx`
   - Import `DatePickerPopup` from `@/features/content`.
   - Import `getOrCreateDaily` from `@/api/nodes`.
   - Add `datePickerOpen` state and a transient anchor element positioned at the saved caret coordinates.
   - In `handleSelectCommand`, handle `commandId === 'date'` by removing the placeholder, closing the trigger popup, and opening the date picker.
   - On date select: `await getOrCreateDaily(isoDate)`, then `insertPill(dayNode.uuid, 'node')` using the UUID returned by the API.
   - On error: log to console, close the picker, and do not insert a link.

### Data flow
1. User types `/date` and selects the command.
2. `InlineTriggers` removes the `/` placeholder and closes `TriggerPopup`.
3. `DatePickerPopup` opens anchored at the caret position.
4. User picks or types a date and confirms.
5. `getOrCreateDaily(isoDate)` creates or fetches the daily page.
6. `insertPill(dayNode.uuid, 'node')` inserts a `node_link` AST node at the cursor position.
7. The editor’s existing persistence flow saves the block.

### Error handling
- If `getOrCreateDaily` rejects, the error is logged, the picker closes, and nothing is inserted. The placeholder has already been removed; the user can undo if needed.
- If the user dismisses the picker without selecting, the picker simply closes.

## Testing
- Add or update a unit test asserting that the slash-command list includes the `date` command.
- Run frontend type-check: `docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit`.
- Run frontend lint: `docker compose -f compose.dev.yaml exec frontend npm run lint`.
- Manual verification:
  1. Open a page in the editor.
  2. Type `/date` and select the command.
  3. Pick a date from the calendar popup.
  4. Confirm a node link pill appears with the daily page name.
  5. Click the link and confirm navigation to the daily page.

## Non-goals / Out of Scope
- Month/year links (the picker supports only a single day selection for this command).
- Backlink creation or special date-link semantics beyond a normal `node_link`.
- Custom link labels; the link displays the daily page’s name.
