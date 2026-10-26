/**
 * BackendDownLock — the risk gate for a long backend outage.
 *
 * The avatar's sync badge is the at-a-glance outage signal; this component
 * stays out of the way until local work turns genuinely risky, then renders
 * the full-screen lock once:
 *
 *  - healthy status (and the null snapshot before the first poll) renders
 *    nothing;
 *  - an outage inside the grace window with a small backlog renders nothing
 *    — there is no banner rung anymore;
 *  - a backlog at or over RISK_BACKLOG_OPS trips the lock immediately,
 *    however young the outage;
 *  - an outage that outlasts OUTAGE_GRACE_MS trips the lock on its own
 *    (a single scheduled tick, no polling);
 *  - the lock says WHY local work is unsafe and what continuing anyway
 *    risks (site-data clearing loses the local-only backlog; long-gap
 *    conflicts resolve by last-writer-wins, not intent);
 *  - "Continue anyway" acknowledges the risk once and returns to the shell
 *    (badge only) until the backend recovers;
 *  - recovery resets the gate — the next outage is judged anew.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import {
  BackendDownLock,
  OUTAGE_GRACE_MS,
  RISK_BACKLOG_OPS,
} from "../src/components/ui/fleet/BackendDownLock.js";
import type { SyncStatusSnapshot } from "../src/core/workspace-client/index.js";

function snapshot(pending: number, failed = 0): SyncStatusSnapshot {
  return {
    status: "error",
    error: "NetworkError",
    pending,
    failed,
    quarantined: 0,
    parked: 0,
    realtime: false,
    cursorSeq: 42,
  };
}

const DOWN = snapshot(3);
const UP: SyncStatusSnapshot = { ...DOWN, status: "idle", error: null };
const RISKY_BACKLOG = snapshot(RISK_BACKLOG_OPS - 100, 150); // pending + failed = threshold + 50

describe("BackendDownLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when healthy or before the first poll", () => {
    const { container: healthy } = render(<BackendDownLock syncStatus={UP} />);
    expect(healthy).toBeEmptyDOMElement();
    const { container: polling } = render(<BackendDownLock syncStatus={null} />);
    expect(polling).toBeEmptyDOMElement();
  });

  it("stays silent through a young outage with a small backlog — no banner rung", () => {
    render(<BackendDownLock syncStatus={DOWN} />);
    act(() => {
      vi.advanceTimersByTime(OUTAGE_GRACE_MS - 1_000);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("locks immediately when the backlog crosses the risk threshold", () => {
    render(<BackendDownLock syncStatus={RISKY_BACKLOG} />);
    expect(screen.getByLabelText("Backend is unavailable")).toBeInTheDocument();
  });

  it("locks on its own when the outage outlasts the grace period", () => {
    render(<BackendDownLock syncStatus={DOWN} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(OUTAGE_GRACE_MS + 100);
    });
    expect(screen.getByLabelText("Backend is unavailable")).toBeInTheDocument();
  });

  it("lock carries the honest risk statement and the escape hatch", () => {
    render(<BackendDownLock syncStatus={RISKY_BACKLOG} />);
    expect(screen.getByText("Backend is unreachable")).toBeInTheDocument();
    expect(screen.getByText(/no longer safe/)).toBeInTheDocument();
    expect(screen.getByText(/last-writer-wins/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue anyway" })).toBeInTheDocument();
  });

  it("continue anyway returns to the shell — no persistent banner rung", () => {
    render(<BackendDownLock syncStatus={RISKY_BACKLOG} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("recovery resets the gate — the next outage starts silent again", () => {
    const { rerender } = render(<BackendDownLock syncStatus={RISKY_BACKLOG} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));

    rerender(<BackendDownLock syncStatus={UP} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    rerender(<BackendDownLock syncStatus={DOWN} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
