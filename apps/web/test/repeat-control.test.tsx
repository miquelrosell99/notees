/**
 * RepeatControl — the deliberate, Google-Tasks-style recurrence authoring
 * surface: toggle + "every N days/weeks/months/years" panel (weekday chips,
 * monthday, ends) with a live summary; plus the two pure pins,
 * `repeatSummaryOf` and `validateRepeatDraft`.
 *
 * The render specs ride a small controlled harness (the kit component is
 * controlled — every valid commit round-trips through onChange into value).
 * RTL idiom copied from ui-primitives.test.tsx (fireEvent + role queries).
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import type { RecurrenceRule } from "@notees/domain";

import { RepeatControl } from "../src/components/ui/kit/RepeatControl.js";
import {
  repeatSummaryOf,
  validateRepeatDraft,
} from "../src/components/ui/kit/repeatSummary.js";

const ANCHOR = "2026-11-06"; // a Friday

function Harness({
  initial = null,
  anchorIso = ANCHOR,
  disabled = false,
  disabledHint,
  onChange,
}: {
  initial?: RecurrenceRule | null;
  anchorIso?: string | null;
  disabled?: boolean;
  disabledHint?: string;
  onChange?: (rule: RecurrenceRule | null) => void;
}) {
  const [value, setValue] = useState<RecurrenceRule | null>(initial);
  return (
    <RepeatControl
      value={value}
      anchorIso={anchorIso}
      disabled={disabled}
      disabledHint={disabledHint}
      onChange={(rule) => {
        onChange?.(rule);
        setValue(rule);
      }}
    />
  );
}

function turnOn() {
  fireEvent.click(screen.getByRole("switch", { name: "Repeat" }));
}

function openUnitDropdown() {
  fireEvent.click(screen.getByRole("button", { name: "Repeat unit" }));
}

function pickUnit(label: string) {
  openUnitDropdown();
  fireEvent.click(screen.getByRole("option", { name: label }));
}

/* ------------------------------------------------------------------ */
/* repeatSummaryOf pins — the four shapes + the ends variants.        */
/* ------------------------------------------------------------------ */

describe("repeatSummaryOf", () => {
  it("pins the daily shapes", () => {
    expect(repeatSummaryOf({ freq: "daily", interval: 1 }, ANCHOR)).toBe("Daily");
    expect(repeatSummaryOf({ freq: "daily", interval: 3 }, ANCHOR)).toBe("Every 3 days");
  });

  it("pins the weekly shapes (the anchor's weekday fills an absent byday)", () => {
    expect(repeatSummaryOf({ freq: "weekly", interval: 1 }, ANCHOR)).toBe("Weekly on Fri");
    expect(
      repeatSummaryOf({ freq: "weekly", interval: 2, byday: ["MO", "FR"] }, ANCHOR),
    ).toBe("Every 2 weeks on Mon, Fri");
  });

  it("pins the monthly shapes (the anchor's day fills an absent bymonthday)", () => {
    expect(repeatSummaryOf({ freq: "monthly", interval: 1 }, ANCHOR)).toBe("Monthly on day 6");
    expect(repeatSummaryOf({ freq: "monthly", interval: 1, bymonthday: [3] }, ANCHOR)).toBe(
      "Monthly on day 3",
    );
  });

  it("pins the yearly shapes", () => {
    expect(repeatSummaryOf({ freq: "yearly", interval: 1 }, ANCHOR)).toBe("Yearly on 6 Nov");
    expect(repeatSummaryOf({ freq: "yearly", interval: 2 }, ANCHOR)).toBe("Every 2 years on 6 Nov");
  });

  it("pins the ends variants", () => {
    expect(repeatSummaryOf({ freq: "daily", interval: 1, count: 1 }, ANCHOR)).toBe(
      "Daily · ends after 1 occurrence",
    );
    expect(repeatSummaryOf({ freq: "daily", interval: 1, count: 10 }, ANCHOR)).toBe(
      "Daily · ends after 10 occurrences",
    );
    expect(repeatSummaryOf({ freq: "daily", interval: 1, until: "2026-12-31" }, ANCHOR)).toBe(
      "Daily · ends 31 Dec 2026",
    );
  });
});

/* ------------------------------------------------------------------ */
/* validateRepeatDraft pins — every Review Focus 4 case.              */
/* ------------------------------------------------------------------ */

describe("validateRepeatDraft", () => {
  it("accepts a plain daily rule", () => {
    expect(validateRepeatDraft({ freq: "daily", interval: 1 }, ANCHOR)).toBeNull();
  });

  it("pins the interval bounds (1..999, whole numbers only)", () => {
    const msg = "Interval must be a whole number from 1 to 999.";
    expect(validateRepeatDraft({ freq: "daily", interval: 0 }, ANCHOR)).toBe(msg);
    expect(validateRepeatDraft({ freq: "daily", interval: 1000 }, ANCHOR)).toBe(msg);
    expect(validateRepeatDraft({ freq: "daily", interval: 2.5 }, ANCHOR)).toBe(msg);
    expect(validateRepeatDraft({ freq: "daily", interval: 999 }, ANCHOR)).toBeNull();
  });

  it("rejects a present-but-empty byday", () => {
    expect(validateRepeatDraft({ freq: "weekly", interval: 1, byday: [] }, ANCHOR)).toBe(
      "Pick at least one weekday.",
    );
    expect(validateRepeatDraft({ freq: "weekly", interval: 1, byday: ["MO"] }, ANCHOR)).toBeNull();
  });

  it("pins the bymonthday bounds (1..31)", () => {
    const msg = "Day of month must be from 1 to 31.";
    expect(validateRepeatDraft({ freq: "monthly", interval: 1, bymonthday: [0] }, ANCHOR)).toBe(msg);
    expect(
      validateRepeatDraft({ freq: "monthly", interval: 1, bymonthday: [32] }, ANCHOR),
    ).toBe(msg);
    expect(
      validateRepeatDraft({ freq: "monthly", interval: 1, bymonthday: [31] }, ANCHOR),
    ).toBeNull();
  });

  it("pins the count floor (≥ 1)", () => {
    expect(validateRepeatDraft({ freq: "daily", interval: 1, count: 0 }, ANCHOR)).toBe(
      "Occurrences must be at least 1.",
    );
    expect(validateRepeatDraft({ freq: "daily", interval: 1, count: 1 }, ANCHOR)).toBeNull();
  });

  it("pins the until shape and the anchor floor (when the anchor is known)", () => {
    expect(validateRepeatDraft({ freq: "daily", interval: 1, until: "not-a-day" }, ANCHOR)).toBe(
      "End date is not a valid day.",
    );
    expect(
      validateRepeatDraft({ freq: "daily", interval: 1, until: "2026-11-05" }, ANCHOR),
    ).toBe(`End date must be on or after ${ANCHOR}.`);
    expect(
      validateRepeatDraft({ freq: "daily", interval: 1, until: "2026-11-06" }, ANCHOR),
    ).toBeNull();
    expect(
      validateRepeatDraft({ freq: "daily", interval: 1, until: "2027-01-01" }, ANCHOR),
    ).toBeNull();
  });

  it("checks the until shape but not the anchor floor when the anchor is unknown", () => {
    expect(validateRepeatDraft({ freq: "daily", interval: 1, until: "2020-01-01" }, null)).toBeNull();
    expect(validateRepeatDraft({ freq: "daily", interval: 1, until: "nope" }, null)).toBe(
      "End date is not a valid day.",
    );
  });

  it("rejects count and until together", () => {
    expect(
      validateRepeatDraft({ freq: "daily", interval: 1, count: 3, until: "2026-12-01" }, ANCHOR),
    ).toBe("Set either an occurrence count or an end date, not both.");
  });
});

/* ------------------------------------------------------------------ */
/* Render + interaction specs.                                        */
/* ------------------------------------------------------------------ */

describe("RepeatControl", () => {
  it("off-state shows the toggle only", () => {
    render(<Harness />);
    expect(screen.getByRole("switch", { name: "Repeat" })).not.toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Repeat interval" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Does not repeat" })).toBeNull();
  });

  it("switching on reveals the panel with interval=1/unit=days defaults", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    turnOn();
    expect(onChange).toHaveBeenCalledWith({ freq: "daily", interval: 1 });
    expect(screen.getByRole("spinbutton", { name: "Repeat interval" })).toHaveValue(1);
    expect(screen.getByText("Daily")).not.toBeNull();
  });

  it("changing the unit to weeks shows seven chips with the anchor's weekday preselected", () => {
    render(<Harness />);
    turnOn();
    pickUnit("weeks");
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Fri" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Weekly on Fri")).not.toBeNull();
  });

  it("deselecting every weekday shows the error live and blocks the commit", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    turnOn();
    pickUnit("weeks");
    expect(onChange).toHaveBeenCalledTimes(2); // on + weekly commit
    fireEvent.click(screen.getByRole("button", { name: "Fri" }));
    expect(onChange).toHaveBeenCalledTimes(2);
    const live = screen.getByText("Pick at least one weekday.");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("group", { name: "Weekdays" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("changing the unit to months prefills the day-of-month from the anchor", () => {
    render(<Harness />);
    turnOn();
    pickUnit("months");
    expect(screen.getByRole("spinbutton", { name: "Day of month" })).toHaveValue(6);
    expect(screen.getByText("Monthly on day 6")).not.toBeNull();
  });

  it("the Ends radio switches between occurrences and date inputs, with a live summary", () => {
    render(<Harness />);
    turnOn();
    fireEvent.click(screen.getByRole("radio", { name: "After" }));
    expect(screen.getByRole("spinbutton", { name: "Occurrences" })).toHaveValue(10);
    expect(screen.getByText("Daily · ends after 10 occurrences")).not.toBeNull();
    expect(screen.queryByLabelText("End date")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "On" }));
    const endDate = screen.getByLabelText("End date") as HTMLInputElement;
    expect(endDate.value).toBe(ANCHOR);
    expect(screen.queryByRole("spinbutton", { name: "Occurrences" })).toBeNull();
    expect(screen.getByText("Daily · ends 6 Nov 2026")).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Never" }));
    expect(screen.queryByLabelText("End date")).toBeNull();
    expect(screen.getByText("Daily")).not.toBeNull();
  });

  it("the summary line updates live as the interval changes", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    turnOn();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Repeat interval" }), {
      target: { value: "2" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ freq: "daily", interval: 2 });
    expect(screen.getByText("Every 2 days")).not.toBeNull();
  });

  it("an invalid interval flags the input, announces the error, and blocks the commit", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    turnOn();
    const interval = screen.getByRole("spinbutton", { name: "Repeat interval" });
    fireEvent.change(interval, { target: { value: "0" } });
    expect(onChange).toHaveBeenCalledTimes(1); // only the turn-on call
    expect(interval).toHaveAttribute("aria-invalid", "true");
    const live = screen.getByText("Interval must be a whole number from 1 to 999.");
    expect(live).toHaveAttribute("aria-live", "polite");
    // Back to a valid value: the error clears and the commit resumes.
    fireEvent.change(interval, { target: { value: "5" } });
    expect(onChange).toHaveBeenLastCalledWith({ freq: "daily", interval: 5 });
    expect(interval).not.toHaveAttribute("aria-invalid");
  });

  it("switching the toggle off calls onChange(null) and hides the panel", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ freq: "daily", interval: 1 }} onChange={onChange} />);
    expect(screen.getByRole("spinbutton", { name: "Repeat interval" })).not.toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Repeat" }));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("spinbutton", { name: "Repeat interval" })).toBeNull();
  });

  it("the 'Does not repeat' button clears the rule", () => {
    const onChange = vi.fn();
    render(
      <Harness initial={{ freq: "weekly", interval: 1, byday: ["MO"] }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Does not repeat" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("disabled renders the hint and fires no onChange", () => {
    const onChange = vi.fn();
    render(
      <Harness disabled disabledHint="Repeats need an online workspace" onChange={onChange} />,
    );
    expect(screen.getByText("Repeats need an online workspace")).not.toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Repeat" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
