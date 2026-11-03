/**
 * workspace_key storage tests: the E2EE custody row (one opaque wrapped-key
 * string per workspace). The server never sees the master key or any
 * unwrapped workspace key — this table is the whole custody surface.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuthStorage } from "../src/auth.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function openStorage(): AuthStorage {
  const dir = mkdtempSync(join(tmpdir(), "notees-workspace-key-"));
  dirs.push(dir);
  return new AuthStorage(join(dir, "relay.db"));
}

describe("workspace_key storage", () => {
  it("put/get round-trips the wrapped key", () => {
    const auth = openStorage();
    expect(auth.getWorkspaceKey("0192a000-0000-7000-8000-000000000001")).toBeUndefined();
    auth.putWorkspaceKey("0192a000-0000-7000-8000-000000000001", "b64u-wrapped-key-material");
    expect(auth.getWorkspaceKey("0192a000-0000-7000-8000-000000000001")).toBe(
      "b64u-wrapped-key-material",
    );
  });

  it("overwrite updates the row (upsert, last write wins)", () => {
    const auth = openStorage();
    auth.putWorkspaceKey("ws-1", "wrapped-v1");
    auth.putWorkspaceKey("ws-1", "wrapped-v2");
    expect(auth.getWorkspaceKey("ws-1")).toBe("wrapped-v2");
  });

  it("rows are keyed per workspace and persist across reopen", () => {
    const auth = openStorage();
    auth.putWorkspaceKey("ws-1", "wrapped-a");
    auth.putWorkspaceKey("ws-2", "wrapped-b");
    const dir = dirs[dirs.length - 1]!;
    const reopened = new AuthStorage(join(dir, "relay.db"));
    expect(reopened.getWorkspaceKey("ws-1")).toBe("wrapped-a");
    expect(reopened.getWorkspaceKey("ws-2")).toBe("wrapped-b");
    expect(reopened.getWorkspaceKey("ws-unknown")).toBeUndefined();
  });
});
