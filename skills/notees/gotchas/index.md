# Gotchas — Notees

High-cost pitfalls specific to this codebase. Each entry links to the detailed reference when available.

## Editor Popup Keepalive

Any portaled popup/modal opened from the custom inline editor (slash follow-on pickers, pill "Edit link" modal, etc.) MUST hold `openPopup()` while open and `closePopup()` on close. Otherwise editor blur unmounts it mid-action and later mutations silently no-op.

- Reference: `references/agents/frontend.md#custom-inline-editor--popup-keepalive-invariant`

## Race Condition Triage

If a bug is "local change disappears after a network mutation", check the **debounced save / query invalidation boundary FIRST**.

- Reference: `references/agents/operations.md`

## Operation Log Immutability

The operation log is immutable. Migrations must fix bad data by appending new operations, not by editing existing envelopes or adding client-side backward-compatibility shims.

- Reference: `references/agents/operations.md`

## Date Page Content vs Display

- Stored content / search / matching use raw text extracted by `nodeNameToText`.
- Rendered names use `nodeNameToDisplayText` / `useNodeDisplayName`, which formats only nodes carrying `SYSTEM_CLASS_UUIDS.day`, `.month`, or `.year`.
- When migrating date content, change only the stored value; the display layer will pick it up automatically.

## UI Composition

Never nest a view mode (`NodeCollection`/`ListView`/`DocumentView`) inside a cell, card, or panel; embed the leaf primitive instead (`NodeCellEditable` pattern).

- Reference: `references/agents/building-blocks.md`

## Dev vs Prod

Development infrastructure settings in `compose.dev.yaml` must never be used in production.
