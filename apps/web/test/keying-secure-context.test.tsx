/**
 * Keying is a secure-context requirement: Web Crypto's `subtle` surface is
 * withheld outside HTTPS/localhost (a plain-http LAN fleet), and both
 * creation keying and the offline workspace's at-rest keying must name that
 * cause honestly — never die on a raw "cannot read properties of undefined".
 * The boot form's "Work offline" button surfaces the rejection through its
 * existing error surface (role="alert") instead of swallowing it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import {
  createKdfRecord,
  generateMasterKey,
} from "@notees/protocol";

import {
  clearCryptoCustody,
  deriveMasterKey,
  ensureOfflineWorkspaceKey,
  keyBundleForCreate,
  SECURE_CONTEXT_KEYING_COPY,
} from "../src/core/crypto-custody.js";
import { setWorkspaceKeyStoreForTests } from "../src/core/master-key-storage.js";
import { BootForm } from "../src/ui/app/BootForm.js";
import type { BootFlow } from "../src/ui/app/useBootFlow.js";
import type { Phase } from "../src/ui/app/useWorkspaceConnection.js";

const PASSWORD = "correct horse battery staple";
const WS = "0192a000-0000-7000-8000-000000000001";

/** Stand-in for the browser withholding Web Crypto's subtle surface. */
function withholdSubtle() {
  const real = globalThis.crypto;
  vi.stubGlobal("crypto", {
    getRandomValues: (array: Uint8Array) => real.getRandomValues(array),
  });
}

async function masterInMemory() {
  const master = await generateMasterKey();
  await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
}

afterEach(() => {
  clearCryptoCustody();
  setWorkspaceKeyStoreForTests(null);
  vi.unstubAllGlobals();
});

describe("keying without a secure context", () => {
  it("creation keying names the cause — the honest no-Web-Crypto message, not a raw TypeError", async () => {
    await masterInMemory();
    withholdSubtle();

    await expect(keyBundleForCreate()).rejects.toThrow(SECURE_CONTEXT_KEYING_COPY);
    await expect(keyBundleForCreate()).rejects.toThrow(/HTTPS or localhost/);
  });

  it("the offline workspace's at-rest keying names the cause too", async () => {
    setWorkspaceKeyStoreForTests({
      async store() {},
      async load() {
        return null;
      },
      async delete() {},
    });
    withholdSubtle();

    await expect(ensureOfflineWorkspaceKey(WS)).rejects.toThrow(SECURE_CONTEXT_KEYING_COPY);
  });
});

describe("BootForm 'Work offline' in a non-secure context", () => {
  /** The real state harness — setError must actually land on the form. */
  function Harness({ handleWorkOffline }: { handleWorkOffline: () => Promise<void> }) {
    const [error, setError] = useState<string | null>(null);
    const [phase, setPhase] = useState<Phase>({ name: "server" });
    const boot = {
      serverUrl: "",
      setServerUrl: vi.fn(),
      email: "",
      setEmail: vi.fn(),
      password: "",
      setPassword: vi.fn(),
      passwordConfirm: "",
      setPasswordConfirm: vi.fn(),
      displayName: "",
      setDisplayName: vi.fn(),
      authTab: "account",
      setAuthTab: vi.fn(),
      signupEnabled: false,
      apiKeyInput: "",
      setApiKeyInput: vi.fn(),
      hint: null,
      serverSuggestion: null,
      handleServerSubmit: vi.fn(),
      handleServerSuggestion: vi.fn(),
      handleSetup: vi.fn(),
      handleLogin: vi.fn(),
      handleSignup: vi.fn(),
      handleApiKeySubmit: vi.fn(),
      handleWorkOffline,
      redeemRecoveryWithCode: vi.fn(),
    } as unknown as BootFlow;
    return (
      <BootForm phase={phase} error={error} setError={setError} setPhase={setPhase} boot={boot} />
    );
  }

  it("a rejecting handleWorkOffline lands on the form's error surface — no dead button, no unhandled rejection", async () => {
    const handleWorkOffline = vi.fn(async () => {
      throw new Error(SECURE_CONTEXT_KEYING_COPY);
    });
    render(<Harness handleWorkOffline={handleWorkOffline} />);

    fireEvent.click(screen.getByRole("button", { name: "Work offline" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(SECURE_CONTEXT_KEYING_COPY);
  });
});
