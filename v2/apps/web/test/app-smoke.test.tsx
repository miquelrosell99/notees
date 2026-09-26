/**
 * App smoke test: the bootstrap form appears. The connect flow needs fetch
 * mocking against a real server and is deliberately out of scope for slice 1.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { App } from "../src/ui/App.js";

describe("App", () => {
  it("shows the bootstrap form on first load", () => {
    render(<App />);

    expect(screen.getByRole("textbox", { name: /server url/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /workspace id/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect/i })).toBeInTheDocument();
  });

  it("remembers previously entered connection details", () => {
    localStorage.setItem("notees.serverUrl", "https://notees.example.com");
    render(<App />);
    expect(screen.getByRole("textbox", { name: /server url/i })).toHaveValue(
      "https://notees.example.com",
    );
  });
});
