/**
 * Spaced-repetition scheduling for memorization cards — the pure v1
 * scheduler. Two algorithms, one state shape:
 *
 * - **SM-2** (the Anki classic): ease factor + fixed first intervals
 *   (1, 6, then `interval * ease`), lapse resets to reps 0 / interval 1
 *   with the ease floor at 1.3.
 * - **FSRS-5** (the default-parameter set, no fitting — v1): stability
 *   `S` in days + difficulty `D` in [1,10]; the first review initializes
 *   both from the weight vector, subsequent reviews move them through the
 *   published FSRS-5 recurrence.
 *
 * One `CardSrsState` carries BOTH algorithms' fields; the active
 * algorithm's fields move while the other's stay byte-for-byte stale
 * (the mid-deck algorithm-switch contract: an sm2-reviewed card graded
 * under fsrs initializes its fsrs fields from defaults and never touches
 * the stale `ease`, and symmetrically).
 *
 * All date math is UTC (`Date.UTC` + `86400_000`, sliced back to
 * `YYYY-MM-DD`) so day arithmetic never crosses a DST boundary.
 */

/** The four review grades (pinned by the `card.review` wire payload). */
export type CardGrade = "again" | "hard" | "good" | "easy";

export type SrsAlgorithm = "sm2" | "fsrs";

export interface CardSrsState {
  due: string | null;          // YYYY-MM-DD; null = unseen
  reps: number;
  interval: number;            // days
  ease: number | null;         // sm2
  difficulty: number | null;   // fsrs
  stability: number | null;    // fsrs, days
}

/** The state of a card that has never been reviewed. */
export const UNSEEN_CARD_STATE: CardSrsState = {
  due: null, reps: 0, interval: 0, ease: null, difficulty: null, stability: null,
};

// SM-2 grade → Anki quality: again 1, hard 3, good 4, easy 5
const SM2_QUALITY: Record<CardGrade, number> = { again: 1, hard: 3, good: 4, easy: 5 };
const SM2_INITIAL_EASE = 2.5;
const SM2_EASE_FLOOR = 1.3;

// FSRS-5 default parameters (fixed for v1; fitting from card_review history is a follow-up)
const FSRS_W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
  1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const FSRS_RATING: Record<CardGrade, number> = { again: 1, hard: 2, good: 3, easy: 4 };
const FSRS_D_MIN = 1;
const FSRS_D_MAX = 10;

/** Weight lookup — the vector is a compile-time constant with 19 fixed entries. */
function w(index: number): number {
  return FSRS_W[index]!;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** UTC day arithmetic: `iso` + `days`, sliced back to YYYY-MM-DD. */
function addDays(iso: string, days: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return new Date(Date.UTC(y, m - 1, d) + days * 86400_000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (UTC math; non-negative on due-or-late reviews). */
function dayDiff(from: string, to: string): number {
  const y1 = Number(from.slice(0, 4)); const m1 = Number(from.slice(5, 7)); const d1 = Number(from.slice(8, 10));
  const y2 = Number(to.slice(0, 4)); const m2 = Number(to.slice(5, 7)); const d2 = Number(to.slice(8, 10));
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400_000);
}

/** SM-2 ease update: `max(1.3, ease + 0.1 - (5-q)(0.08 + (5-q)0.02))`. */
function nextSm2Ease(ease: number, quality: number): number {
  const delta = 5 - quality;
  return Math.max(SM2_EASE_FLOOR, ease + 0.1 - delta * (0.08 + delta * 0.02));
}

function nextSm2State(state: CardSrsState, grade: CardGrade, todayIso: string): CardSrsState {
  const quality = SM2_QUALITY[grade];
  // SM-2 never touches the fsrs fields; ease initializes from the SM-2
  // default when the card arrives from the fsrs algorithm (or unseen).
  const ease = nextSm2Ease(state.ease ?? SM2_INITIAL_EASE, quality);
  let reps: number;
  let interval: number;
  if (grade === "again") {
    reps = 0;
    interval = 1;
  } else {
    reps = state.reps + 1;
    if (state.reps === 0) interval = 1;
    else if (state.reps === 1) interval = 6;
    else interval = Math.round(state.interval * (state.ease ?? SM2_INITIAL_EASE));
  }
  return { due: addDays(todayIso, interval), reps, interval, ease, difficulty: state.difficulty, stability: state.stability };
}

/** Retrievability R(t,S) = (1 + t/(9S))^-1, t in elapsed days. */
function retrievability(elapsedDays: number, stability: number): number {
  return Math.pow(1 + elapsedDays / (9 * stability), -1);
}

function nextFsrsState(state: CardSrsState, grade: CardGrade, todayIso: string): CardSrsState {
  const rating = FSRS_RATING[grade];
  // FSRS never touches the sm2 ease field.
  const ease = state.ease;

  // First-review path: the incoming state lacks THIS algorithm's fields
  // (mid-deck switch or unseen) — initialize from the FSRS-5 default
  // weights, regardless of reps, same-day re-view (interval 0).
  if (state.stability === null || state.difficulty === null) {
    const stability = w(rating - 1);
    const difficulty = clamp(w(4), FSRS_D_MIN, FSRS_D_MAX);
    return { due: todayIso, reps: rating === 1 ? 0 : 1, interval: 0, ease, difficulty, stability };
  }

  const stability = state.stability;
  const difficulty = state.difficulty;
  // Elapsed days since the last review: the scheduled interval plus the
  // slip (or lead) between the due date and today.
  const elapsed = state.interval + (state.due === null ? 0 : dayDiff(state.due, todayIso));
  const r = retrievability(Math.max(0, elapsed), stability);

  // Difficulty first — the FSRS-5 stability recurrence consumes D', the
  // post-update difficulty.
  const nextDifficulty = clamp(difficulty - w(6) * (rating - 3), FSRS_D_MIN, FSRS_D_MAX);
  let nextStability: number;
  if (rating === 1) {
    // Lapse path: S' = w11 * D'^-w12 * ((S+1)^w13 - 1) * e^((1-R)w14)
    nextStability =
      w(11) * Math.pow(nextDifficulty, -w(12)) *
      (Math.pow(stability + 1, w(13)) - 1) * Math.exp((1 - r) * w(14));
  } else {
    // S' = S * (1 + e^w8 * (11-D') * S^-w9 * (e^((1-R)w10) - 1))
    nextStability =
      stability * (1 + Math.exp(w(8)) * (11 - nextDifficulty) *
        Math.pow(stability, -w(9)) * (Math.exp((1 - r) * w(10)) - 1));
  }

  const interval = Math.max(0, Math.round(nextStability));
  const reps = rating === 1 ? 0 : state.reps + 1;
  return { due: addDays(todayIso, interval), reps, interval, ease, difficulty: nextDifficulty, stability: nextStability };
}

/**
 * The next SRS state after grading `grade` with `algorithm` on `todayIso`
 * (YYYY-MM-DD). Pure: returns a fresh state, never mutates.
 */
export function nextCardState(
  state: CardSrsState,
  grade: CardGrade,
  algorithm: SrsAlgorithm,
  todayIso: string,
): CardSrsState {
  return algorithm === "sm2" ? nextSm2State(state, grade, todayIso) : nextFsrsState(state, grade, todayIso);
}

/** A card is due when unseen, due today, or overdue — string compare on YYYY-MM-DD is chronological. */
export function isCardDue(state: CardSrsState, todayIso: string): boolean {
  return state.due === null || state.due <= todayIso;
}
