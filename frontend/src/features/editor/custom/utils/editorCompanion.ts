/**
 * Editor companion detection.
 *
 * Companion UI (popups, toolbars, widgets) is marked with `data-editor-companion`
 * and rendered outside the editable root, usually via a portal. Keyboard and
 * input events that originate inside a companion should be handled by the
 * companion itself and must not leak into the editor.
 */

export function isInsideEditorCompanion(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('[data-editor-companion]') !== null;
}
