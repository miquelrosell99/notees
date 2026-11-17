import browser from "webextension-polyfill";

export const MENU_SOURCE_ID = "notees-capture-source";
export const MENU_READLATER_ID = "notees-capture-readlater";

/**
 * (Re)build context menus from the feature toggles. Both entries always
 * exist; the toggles control `enabled`, so an off feature shows as a greyed
 * entry instead of vanishing. Clicking a disabled entry never fires
 * contextMenus.onClicked, so the capture path needs no toggle re-check
 * beyond performCapture's own guard.
 */
export function buildMenus(features: { bibliography: boolean; readLater: boolean }): void {
  void browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: MENU_SOURCE_ID,
      title: "Save to bibliography",
      contexts: ["page", "link"],
      enabled: features.bibliography,
    });
    browser.contextMenus.create({
      id: MENU_READLATER_ID,
      title: "Read later",
      contexts: ["page", "link"],
      enabled: features.readLater,
    });
  });
}
