/**
 * InProcessStoreBanner tests: the in-process store mode is
 * loudly warned — the banner renders the explanation and dismisses for the
 * session.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { InProcessStoreBanner } from "../src/components/ui/fleet/InProcessStoreBanner.js";

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

  it("renders the diagnosed cause when provided", () => {
    render(
      <InProcessStoreBanner reason="plain http on a non-localhost address is not a secure context" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("not a secure context");
  });
});
