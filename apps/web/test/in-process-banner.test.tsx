/**
 * InProcessStoreBanner tests: the in-process store mode is
 * loudly warned — the banner renders the explanation and dismisses for the
 * session.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { InProcessStoreBanner } from "../src/ui/components/ui/InProcessStoreBanner.js";

describe("InProcessStoreBanner", () => {
  it("renders the warning with a dismiss action", () => {
    render(<InProcessStoreBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Background store unavailable — running in-process",
    );
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("hides on dismiss", () => {
    render(<InProcessStoreBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
