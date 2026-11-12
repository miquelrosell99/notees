/**
 * ConnectingScreen — the bootstrap "Connecting…" surface: composes the kit
 * LoadingScreen. With a live progress fraction the label is "Catching up… N%"
 * (rounded down) and the kit renders the progress bar at that width; without
 * one the phase text ("Catching up… N operations") shows with the plain
 * spinner. The fraction is clamped 0–1.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConnectingScreen } from "../src/ui/app/ConnectingScreen.js";

describe("ConnectingScreen", () => {
  it("without progress: the catch-up phase renders the clean label (no raw op count), no bar", () => {
    render(<ConnectingScreen label="Catching up… 0 operations" progress={null} />);
    expect(screen.getByText("Catching up…")).toBeInTheDocument();
    expect(screen.queryByText(/operations/)).toBeNull();
    expect(document.querySelector(".loading-screen__progress")).toBeNull();
  });

  it("non-catch-up phase text renders verbatim", () => {
    render(<ConnectingScreen label="Fetching latest snapshot…" progress={null} />);
    expect(screen.getByText("Fetching latest snapshot…")).toBeInTheDocument();
  });

  it("with a fraction: renders the percent label and the bar at that width", () => {
    render(<ConnectingScreen label="Catching up… 128,450 operations" progress={0.42} />);
    expect(screen.getByText("Catching up… 42%")).toBeInTheDocument();
    // The count text is replaced, not echoed.
    expect(screen.queryByText("Catching up… 128,450 operations")).toBeNull();
    const bar = document.querySelector<HTMLElement>(".loading-screen__progress-bar");
    expect(bar).not.toBeNull();
    expect(bar!.style.width).toBe("42%");
  });

  it("rounds down and clamps the fraction into 0–1", () => {
    render(<ConnectingScreen label="Connecting…" progress={0.429} />);
    expect(screen.getByText("Catching up… 42%")).toBeInTheDocument();
  });

  it("clamps an out-of-range fraction (the total can creep upward mid-replay)", () => {
    const { rerender } = render(<ConnectingScreen label="Connecting…" progress={1.7} />);
    expect(screen.getByText("Catching up… 100%")).toBeInTheDocument();
    expect(document.querySelector<HTMLElement>(".loading-screen__progress-bar")!.style.width).toBe("100%");
    rerender(<ConnectingScreen label="Connecting…" progress={-0.2} />);
    expect(screen.getByText("Catching up… 0%")).toBeInTheDocument();
  });

  it("renders the connect error when present", () => {
    render(<ConnectingScreen label="Connecting…" progress={null} error="Backend unreachable" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Backend unreachable");
  });
});
