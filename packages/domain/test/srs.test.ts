import { describe, expect, it } from "vitest";
import { UNSEEN_CARD_STATE, isCardDue, nextCardState } from "../src/srs";

const TODAY = "2026-10-28";

describe("sm2", () => {
  it("first good: reps 1, interval 1, due tomorrow, ease 2.5", () => {
    const s = nextCardState(UNSEEN_CARD_STATE, "good", "sm2", TODAY);
    expect(s).toEqual({ due: "2026-10-29", reps: 1, interval: 1, ease: 2.5, difficulty: null, stability: null });
  });
  it("lapse resets reps and interval, floors ease at 1.3", () => {
    const reviewed = { due: "2026-10-28", reps: 5, interval: 21, ease: 1.35, difficulty: null, stability: null };
    const s = nextCardState(reviewed, "again", "sm2", TODAY);
    expect(s.reps).toBe(0); expect(s.interval).toBe(1); expect(s.ease).toBe(1.3);
  });
});

describe("fsrs", () => {
  it("first good initializes difficulty and stability, not null", () => {
    const s = nextCardState(UNSEEN_CARD_STATE, "good", "fsrs", TODAY);
    expect(s.ease).toBeNull();            // sm2 field untouched
    expect(s.difficulty).not.toBeNull();
    expect(s.stability).toBeGreaterThan(0);
    expect(s.due).toBe(TODAY);            // same-day re-view for first fsrs step
  });
  it("Review Focus 3: sm2-reviewed card graded under fsrs initializes fsrs fields, keeps ease", () => {
    const sm2 = nextCardState(UNSEEN_CARD_STATE, "good", "sm2", TODAY);
    const fsrs = nextCardState({ ...sm2, stability: null, difficulty: null }, "good", "fsrs", TODAY);
    expect(fsrs.ease).toBe(2.5);          // stale sm2 field preserved, not corrupted
    expect(fsrs.stability).not.toBeNull();
  });
});

describe("isCardDue", () => {
  it("unseen cards are due; future-dated are not", () => {
    expect(isCardDue(UNSEEN_CARD_STATE, TODAY)).toBe(true);
    expect(isCardDue({ ...UNSEEN_CARD_STATE, due: "2026-10-29" }, TODAY)).toBe(false);
    expect(isCardDue({ ...UNSEEN_CARD_STATE, due: TODAY }, TODAY)).toBe(true);
  });
});
