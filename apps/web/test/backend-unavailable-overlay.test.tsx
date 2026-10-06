/**
 * BackendUnavailableOverlay — the backend-down ladder:
 *
 *  - healthy status (and the null snapshot before the first poll) renders
 *    nothing;
 *  - an outage first shows the dismissible banner — the lock is never the
 *    first surface;
 *  - dismissing the banner swaps to the full-screen lock, which carries the
 *    "Continue anyway" escape next to an honest statement of what continued
 *    local work risks (site-data clearing loses the local-only backlog;
 *    long-gap conflicts resolve by last-writer-wins, not intent);
 *  - escaping returns to the shell under a persistent banner with NO dismiss
 *    button — the degraded state can never render invisibly;
 *  - recovery resets the ladder: the next outage starts at the banner again
 *    (before this suite, one dismissal latched the lock for every later
 *    outage).
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { BackendUnavailableOverlay } from "../src/ui/components/ui/BackendUnavailableOverlay.js";
import type { SyncStatusSnapshot } from "../src/core/workspace-client.js";

const DOWN: SyncStatusSnapshot = {
  status: "error",
  error: "NetworkError",
  pending: 3,
  failed: 0,
  quarantined: 0,
  parked: 0,
  realtime: false,
  cursorSeq: 42,
};

const UP: SyncStatusSnapshot = { ...DOWN, status: "idle", error: null };

describe("BackendUnavailableOverlay", () => {
  it("renders nothing when healthy or before the first poll", () => {
    const { container: healthy } = render(<BackendUnavailableOverlay syncStatus={UP} />);
    expect(healthy).toBeEmptyDOMElement();
    const { container: polling } = render(<BackendUnavailableOverlay syncStatus={null} />);
    expect(polling).toBeEmptyDOMElement();
  });

  it("shows the dismissible banner first on outage — the lock never leads", () => {
    render(<BackendUnavailableOverlay syncStatus={DOWN} />);
    expect(screen.getByRole("status")).toHaveTextContent("working locally until it recovers");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.queryByText("Continue anyway")).not.toBeInTheDocument();
  });

  it("dismiss → lock with the honest escape; escape → persistent banner", () => {
    render(<BackendUnavailableOverlay syncStatus={DOWN} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    // Lock: says WHY local work is unsafe and what continuing anyway risks.
    expect(screen.getByText("Backend is unreachable")).toBeInTheDocument();
    expect(screen.getByText(/no longer safe/)).toBeInTheDocument();
    expect(screen.getByText(/last-writer-wins/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));

    // Persistent banner: still visible, no dismiss affordance.
    expect(screen.getByRole("status")).toHaveTextContent("Edits sync when it recovers");
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("recovery resets the ladder — the next outage starts at the banner", () => {
    const { rerender } = render(<BackendUnavailableOverlay syncStatus={DOWN} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByText("Backend is unreachable")).toBeInTheDocument();

    rerender(<BackendUnavailableOverlay syncStatus={UP} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    rerender(<BackendUnavailableOverlay syncStatus={DOWN} />);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.queryByText("Backend is unreachable")).not.toBeInTheDocument();
  });
});
