/**
 * App smoke tests: the boot form shows the server URL field with Continue +
 * "Work offline" (no API key / workspace UUID prompts — accounts replaced
 * them), the server-info probe picks the setup vs login screen, and the
 * server URL is remembered.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { App } from "../src/ui/App.js";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("App boot", () => {
  it("shows the server form with Continue and Work offline on first load", () => {
    render(<App />);
    expect(screen.getByRole("textbox", { name: /server url/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /work offline/i })).toBeInTheDocument();
    // No raw-credential prompts.
    expect(screen.queryByLabelText(/api key/i)).toBeNull();
    expect(screen.queryByLabelText(/workspace id/i)).toBeNull();
  });

  it("remembers a previously entered server URL", () => {
    localStorage.setItem("notees.serverUrl", "https://notees.example.com");
    render(<App />);
    expect(screen.getByRole("textbox", { name: /server url/i })).toHaveValue(
      "https://notees.example.com",
    );
  });

  it("server-info with setupRequired shows the initial-setup screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/server-info")) {
          return Response.json({ setupRequired: true, version: "test", name: "notees-server" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(<App />);
    fireEvent.change(screen.getByRole("textbox", { name: /server url/i }), {
      target: { value: "https://notees.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(await screen.findByText(/initial setup/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
  });

  it("server-info without setupRequired shows the login screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/server-info")) {
          return Response.json({ setupRequired: false, version: "test", name: "notees-server" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(<App />);
    fireEvent.change(screen.getByRole("textbox", { name: /server url/i }), {
      target: { value: "https://notees.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(await screen.findByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /email/i })).toBeInTheDocument();
  });

  it("a probe failure surfaces as an error, not a silent hang", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 502 })),
    );
    render(<App />);
    fireEvent.change(screen.getByRole("textbox", { name: /server url/i }), {
      target: { value: "https://down.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(screen.getByText(/HTTP 502/i)).toBeInTheDocument());
  });
});
