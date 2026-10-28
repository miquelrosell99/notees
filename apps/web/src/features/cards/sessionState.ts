/**
 * sessionState — the review-session handoff from the Cards hub to the
 * review surface (the /cards/review route Task 10 renders).
 *
 * The hub's Review gestures (the bucket chip, the header's Review button,
 * a row's trailing Review action) collect the card id set the session
 * covers and hand it across the route boundary through sessionStorage —
 * the transient, device-local channel (never an op, never a URL param:
 * a card-id list is session state, not a shareable address). The payload
 * rides `notees.cards.session` as `{ cardIds, filterSummary }`;
 * `filterSummary` names the hub subset the session started from ("all
 * cards", the quick text, a structured filter) for the review surface's
 * header. A deep link to /cards/review with no stored session is the
 * all-due-cards fallback — Task 10 defines it.
 *
 * Navigation is the framework-free pushState seam (the pushSettingsSection
 * precedent in routing.ts): push the URL, then dispatch a synthetic
 * popstate so the App's popstate handler maps the landing back to view
 * state — any /cards/* path boots the cards hub (navFromPath).
 */

import { pathForCardsReview } from "../../ui/app/routing.js";

export interface CardsSessionState {
  cardIds: string[];
  /** The hub subset the session covers ("" = unfiltered). */
  filterSummary: string;
}

export const CARDS_SESSION_STORAGE_KEY = "notees.cards.session";

/** Read the handed-off session (null when absent/corrupt — the deep-link fallback). */
export function readCardsSession(): CardsSessionState | null {
  const raw = sessionStorage.getItem(CARDS_SESSION_STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CardsSessionState>;
    if (!Array.isArray(parsed.cardIds)) return null;
    return { cardIds: parsed.cardIds.filter((id) => typeof id === "string"), filterSummary: typeof parsed.filterSummary === "string" ? parsed.filterSummary : "" };
  } catch {
    return null;
  }
}

/** Clear the handed-off session (the review surface consumes it). */
export function clearCardsSession(): void {
  sessionStorage.removeItem(CARDS_SESSION_STORAGE_KEY);
}

/**
 * Start a review session over `cardIds`: store the payload and navigate to
 * /cards/review (pushState + the synthetic popstate that drives the App's
 * popstate handler).
 */
export function startCardsSession(cardIds: string[], filterSummary = ""): void {
  const state: CardsSessionState = { cardIds, filterSummary };
  sessionStorage.setItem(CARDS_SESSION_STORAGE_KEY, JSON.stringify(state));
  window.history.pushState({ cards: "review" }, "", pathForCardsReview());
  window.dispatchEvent(new Event("popstate"));
}
