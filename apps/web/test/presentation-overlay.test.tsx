/**
 * PresentationOverlay tests (§34.26 P1/P6) — the kit's fullscreen host:
 * portal render with slide counter and toolbar, Esc exit via the overlay
 * stack, the presentation keymap (arrows / space / PageUp / PageDown with
 * clamping), edge click zones, focus trap, and the auto-hiding chrome.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import {
  PRESENTATION_CHROME_HIDE_MS,
  PresentationOverlay,
} from "../src/ui/components/ui/PresentationOverlay.js";

function press(key: string): void {
  // Document-level listeners (the overlay's keymap + the overlay stack's
  // Escape handling) take raw document events.
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

/** Controlled harness: feeds index changes back like a real deck host. */
function DeckHarness({
  count = 3,
  onIndexChangeSpy,
}: {
  count?: number;
  onIndexChangeSpy?: ((index: number) => void) | undefined;
}) {
  const [index, setIndex] = useState(0);
  return (
    <PresentationOverlay
      isOpen
      onClose={() => {}}
      index={index}
      count={count}
      onIndexChange={(next) => {
        onIndexChangeSpy?.(next);
        setIndex(next);
      }}
    >
      <p>Slide {index + 1}</p>
    </PresentationOverlay>
  );
}

describe("PresentationOverlay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when closed", () => {
    render(
      <PresentationOverlay isOpen={false} onClose={() => {}} index={0} count={3}>
        <p>Slide</p>
      </PresentationOverlay>,
    );
    expect(document.body.querySelector(".presentation-overlay")).toBeNull();
  });

  it("portals a fullscreen dialog with the slide counter and toolbar", () => {
    render(
      <PresentationOverlay isOpen onClose={() => {}} index={1} count={4} ariaLabel="Deck">
        <p>Second slide</p>
      </PresentationOverlay>,
    );
    const overlay = document.body.querySelector(".presentation-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute("role")).toBe("dialog");
    expect(overlay!.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("Second slide")).toBeTruthy();
    expect(screen.getByText("2 / 4")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous slide" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next slide" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exit presentation" })).toBeTruthy();
  });

  it("Escape closes via the overlay stack regardless of DOM focus", () => {
    const onClose = vi.fn();
    render(
      <PresentationOverlay isOpen onClose={onClose} index={0} count={3}>
        <p>Slide</p>
      </PresentationOverlay>,
    );
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the keymap advances and retreats with clamping at the ends", () => {
    const onIndexChange = vi.fn();
    render(<DeckHarness onIndexChangeSpy={onIndexChange} />);

    press("ArrowRight");
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    expect(document.body.querySelector(".presentation-overlay__counter")?.textContent).toBe("2 / 3");

    press("ArrowDown");
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    press("PageDown");
    expect(onIndexChange).toHaveBeenLastCalledWith(2); // clamped at the last slide
    press(" ");
    expect(onIndexChange).toHaveBeenLastCalledWith(2); // still clamped

    press("ArrowLeft");
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    press("ArrowUp");
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
    const calls = onIndexChange.mock.calls.length;
    press("PageUp");
    expect(onIndexChange.mock.calls.length).toBe(calls); // clamped at the first slide
  });

  it("keyboard navigation is inert without a slide stream", () => {
    const onIndexChange = vi.fn();
    render(
      <PresentationOverlay isOpen onClose={() => {}}>
        <p>Plain fullscreen body</p>
      </PresentationOverlay>,
    );
    press("ArrowRight");
    expect(onIndexChange).not.toHaveBeenCalled();
    expect(document.body.querySelector(".presentation-overlay__counter")).toBeNull();
    expect(document.body.querySelector(".presentation-overlay__zone")).toBeNull();
    // Exit chrome is still present.
    expect(screen.getByRole("button", { name: "Exit presentation" })).toBeTruthy();
  });

  it("toolbar buttons step through the deck and disable at the ends", () => {
    const onIndexChange = vi.fn();
    render(<DeckHarness count={2} onIndexChangeSpy={onIndexChange} />);

    const prev = screen.getByRole("button", { name: "Previous slide" });
    const next = screen.getByRole("button", { name: "Next slide" });
    expect(prev).toHaveProperty("disabled", true);

    fireEvent.click(next);
    expect(onIndexChange).toHaveBeenCalledWith(1);
    expect(document.body.querySelector(".presentation-overlay__counter")?.textContent).toBe("2 / 2");
    expect(prev).toHaveProperty("disabled", false);
    expect(next).toHaveProperty("disabled", true);

    fireEvent.click(prev);
    expect(onIndexChange).toHaveBeenCalledWith(0);
    expect(document.body.querySelector(".presentation-overlay__counter")?.textContent).toBe("1 / 2");
    fireEvent.click(screen.getByRole("button", { name: "Exit presentation" }));
    // Exit goes through onClose (asserted in the Esc spec) — the button exists.
  });

  it("edge click zones navigate", () => {
    const onIndexChange = vi.fn();
    render(
      <PresentationOverlay isOpen onClose={() => {}} index={1} count={3} onIndexChange={onIndexChange}>
        <p>Slide</p>
      </PresentationOverlay>,
    );
    fireEvent.click(document.body.querySelector(".presentation-overlay__zone--prev")!);
    expect(onIndexChange).toHaveBeenCalledWith(0);
    fireEvent.click(document.body.querySelector(".presentation-overlay__zone--next")!);
    expect(onIndexChange).toHaveBeenCalledWith(2);
  });

  it("traps focus: opening focuses the stage, Tab cycles inside the chrome", () => {
    render(
      <PresentationOverlay isOpen onClose={() => {}} index={0} count={2}>
        <p>Slide</p>
      </PresentationOverlay>,
    );
    const overlay = document.body.querySelector<HTMLElement>(".presentation-overlay")!;
    // Auto-focus lands on the stage container (initialFocusRef).
    expect(document.activeElement).toBe(overlay);

    const focusables = Array.from(
      overlay.querySelectorAll<HTMLElement>("button:not([disabled])"),
    );
    expect(focusables.length).toBeGreaterThan(0);
    const last = focusables[focusables.length - 1]!;
    const first = focusables[0]!;
    last.focus();
    fireEvent.keyDown(overlay, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  describe("auto-hiding chrome", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("fades the toolbar after the idle delay and restores it on activity", () => {
      render(
        <PresentationOverlay isOpen onClose={() => {}} index={0} count={2}>
          <p>Slide</p>
        </PresentationOverlay>,
      );
      const overlay = () => document.body.querySelector(".presentation-overlay")!;
      expect(overlay()).not.toHaveClass("presentation-overlay--chrome-hidden");

      act(() => {
        vi.advanceTimersByTime(PRESENTATION_CHROME_HIDE_MS + 100);
      });
      expect(overlay()).toHaveClass("presentation-overlay--chrome-hidden");

      fireEvent.pointerMove(overlay());
      expect(overlay()).not.toHaveClass("presentation-overlay--chrome-hidden");

      act(() => {
        vi.advanceTimersByTime(PRESENTATION_CHROME_HIDE_MS + 100);
      });
      expect(overlay()).toHaveClass("presentation-overlay--chrome-hidden");
    });
  });
});
