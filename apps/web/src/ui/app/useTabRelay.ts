/**
 * The App-side wiring of the connector tab relay: installs the window
 * listener once per mount and answers capture requests through the LIVE
 * session — the active client from clientRef, the workspace's configured
 * server origin, the auth/feature/key gates (the relay's Review Focus
 * set), and a kit toast on success so the capture is visible in the tab
 * that performed it.
 */

import { useEffect } from "react";

import type { WorkspaceFeature } from "@notees/protocol";

import type { AnyClient } from "../../features/sidebar/FavoritesRecents.js";
import { notificationStore } from "../../components/ui/kit/notificationStore.js";
import {
  installTabRelay,
  type CaptureRequestMessage,
  type CaptureResult,
} from "../../features/connector/tabRelay.js";
import { captureWebPage, type CapturePayload } from "../../features/connector/captureWebPage.js";

/** The readItLater id arrives via a vendor bump — tolerate its absence. */
const READ_IT_LATER = "readItLater" as unknown as WorkspaceFeature;

export function useTabRelay(args: {
  clientRef: { current: AnyClient | null };
  serverUrl: string;
  /** Empty = no authed session in this tab. */
  token: string;
  /** Positive plaintext knowledge (the connection's `plaintext` flag). */
  workspacePlaintext: boolean;
  /** Non-null while a keyed workspace waits on the unlock modal. */
  unlockRequest: unknown;
}): void {
  const { clientRef, serverUrl, token, workspacePlaintext, unlockRequest } = args;

  useEffect(() => {
    return installTabRelay(window, {
      serverOrigin: () => {
        const url = serverUrl.trim();
        if (url === "" || token === "") return null;
        try {
          return new URL(url).origin;
        } catch {
          return null;
        }
      },
      handleCapture: async (payload: CaptureRequestMessage["payload"]): Promise<CaptureResult> => {
        const client = clientRef.current;
        if (client === null) {
          return { ok: false, code: "not_authenticated", message: "No workspace is open in this tab." };
        }
        // Review Focus 5: a keyed workspace whose master key is locked must
        // never attempt a stamped write — the unlock modal IS the lock signal.
        if (!workspacePlaintext && unlockRequest !== null) {
          return {
            ok: false,
            code: "failed",
            message: "This workspace is locked — unlock Notees in this tab and retry.",
          };
        }
        // Review Focus 2: the workspace feature gates the matching mode.
        const gate: WorkspaceFeature | null =
          payload.mode === "readlater" ? READ_IT_LATER : "sources";
        if (!client.isFeatureEnabled(gate)) {
          return {
            ok: false,
            code: "feature_disabled",
            message:
              payload.mode === "readlater"
                ? "Read later is off for this workspace — enable it in Settings → Features."
                : "The Sources family is off for this workspace.",
          };
        }
        try {
          const objectId = await captureWebPage(client, {
            url: payload.url,
            title: payload.title,
            mode: payload.mode,
            note: payload.note,
          } satisfies CapturePayload);
          notificationStore.success(
            payload.mode === "readlater" ? "Saved to Read later" : "Saved to your library",
            payload.title,
          );
          return { ok: true, objectId };
        } catch (error: unknown) {
          return {
            ok: false,
            code: "failed",
            message: error instanceof Error ? error.message : "Capture failed.",
          };
        }
      },
    });
  }, [clientRef, serverUrl, token, workspacePlaintext, unlockRequest]);
}
