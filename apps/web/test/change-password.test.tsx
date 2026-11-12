/**
 * Change-password card (settings → Account): the current password unlocks
 * the kdf record, the SAME master key re-wraps under the new password
 * (keyFp computed client-side, compared server-side), and the route installs
 * the record. Wrong current password surfaces as a form error; the raw
 * master bytes never leave the submit call.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createKdfRecord, generateMasterKey } from "@notees/protocol";

import { SettingsPage } from "../src/features/settings/SettingsPage.js";

const SERVER = "https://notees.example.com";
const EMAIL = "admin@example.com";
const CURRENT = "current-password-1";
const NEXT = "next-password-22";

/** A REAL kdf record wrapping a fresh master under the current password. */
async function realKdfRecord() {
  return createKdfRecord(await generateMasterKey(), CURRENT);
}

function renderCard() {
  render(
    <SettingsPage
      section="account"
      onNavigate={() => {}}
      serverUrl={SERVER}
      token="session-token"
      user={{
        id: "0192a000-0000-7000-8000-0000000000u1",
        email: EMAIL,
        displayName: null,
        name: null,
        surnames: null,
        avatarUrl: null,
        isAdmin: true,
      }}
      onSignOut={() => {}}
      onForgetServer={() => {}}
      onConnectServer={() => {}}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("change-password card", () => {
  it("a valid change calls /auth/unlock then /auth/change-password with a keyFp", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: init?.body === undefined ? {} : JSON.parse(String(init.body)) });
        if (url.endsWith("/api/auth/unlock")) {
          return Response.json({ kdf: await realKdfRecord() });
        }
        if (url.endsWith("/api/auth/change-password")) {
          return Response.json({ ok: true });
        }
        if (url.endsWith("/api/api-keys")) {
          return Response.json({ apiKeys: [] });
        }
        return Response.json({});
      }),
    );

    renderCard();
    fireEvent.change(screen.getByLabelText(/^current password$/i), { target: { value: CURRENT } });
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: NEXT } });
    fireEvent.change(screen.getByLabelText(/^confirm new password$/i), { target: { value: NEXT } });
    fireEvent.click(screen.getByRole("button", { name: /^change password$/i }));

    await screen.findByText(/password changed/i, {}, { timeout: 20_000 });
    const unlockCall = calls.find((c) => c.url.endsWith("/api/auth/unlock"));
    const changeCall = calls.find((c) => c.url.endsWith("/api/auth/change-password"));
    expect(unlockCall?.body).toMatchObject({ email: EMAIL, password: CURRENT });
    expect(changeCall?.body.currentPassword).toBe(CURRENT);
    const record = changeCall?.body.newKdfRecord as { keyFp?: string; wrappedMasterKey?: string };
    expect(record.keyFp).toBeDefined();
    expect(record.keyFp!.length).toBeGreaterThan(10);
  });

  it("a rejected change-password surfaces the server's message as a form error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/auth/unlock")) return Response.json({ kdf: await realKdfRecord() });
        if (url.endsWith("/api/auth/change-password")) {
          return Response.json(
            { error: { message: "the new password record wraps a DIFFERENT key" } },
            { status: 422 },
          );
        }
        if (url.endsWith("/api/api-keys")) {
          return Response.json({ apiKeys: [] });
        }
        return Response.json({});
      }),
    );

    renderCard();
    fireEvent.change(screen.getByLabelText(/^current password$/i), { target: { value: CURRENT } });
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: NEXT } });
    fireEvent.change(screen.getByLabelText(/^confirm new password$/i), { target: { value: NEXT } });
    fireEvent.click(screen.getByRole("button", { name: /^change password$/i }));

    await screen.findByText(/wraps a DIFFERENT key/i, {}, { timeout: 20_000 });
  });

  it("mismatched confirmation never reaches the network", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/api-keys")) return Response.json({ apiKeys: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCard();
    fireEvent.change(screen.getByLabelText(/^current password$/i), { target: { value: CURRENT } });
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: NEXT } });
    fireEvent.change(screen.getByLabelText(/^confirm new password$/i), { target: { value: "different" } });
    fireEvent.click(screen.getByRole("button", { name: /^change password$/i }));
    await screen.findByText(/do not match/i, {}, { timeout: 20_000 });
    await waitFor(() => {
      const authCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/auth/"));
      expect(authCalls).toHaveLength(0);
    });
  });
});
