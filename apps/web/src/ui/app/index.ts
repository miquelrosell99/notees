/**
 * ui/app — the app-shell module family (extracted from App.tsx, the
 * composition root). Public surface barrel: App.tsx and the tests import
 * the family through here. Internal cross-imports stay direct (module →
 * module) — a barrel import inside the family would invite cycles.
 *
 * Internal-only modules (no consumer outside the family): `clients.ts`
 * (AnyClient), `storeMode.ts`.
 */

export * from "./storage.js";
export * from "./routing.js";
export * from "./keymap.js";
export * from "./railCardOrder.js";
export * from "./HubView.js";
export * from "./store-connection.js";
export * from "./useWorkspaceConnection.js";
export * from "./useServerProbe.js";
export * from "./useAuthFlow.js";
export * from "./useBootFlow.js";
export * from "./BootForm.js";
export * from "./useGlobalGestures.js";
export * from "./useRailCards.js";
export * from "./useUndoChrome.js";
export * from "./AppTopBar.js";
export * from "./AppBody.js";
export * from "./AppModals.js";
export * from "./AppOverlays.js";
