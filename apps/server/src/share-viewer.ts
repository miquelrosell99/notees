/**
 * The key-in-fragment share viewer (plan 08, spec §4 — Standard Notes /
 * Proton Drive pattern).
 *
 * A shared page can be a SEALED ARTIFACT: the publisher rendered the subtree
 * to self-contained HTML, sealed it with a fresh random 256-bit share key,
 * and the server stores ONLY the ciphertext (`share_tokens.artifact`).
 * `GET /s/:token` then serves this page — one request, zero build or runtime
 * dependencies, no external scripts/styles: a share renders on anyone's
 * browser, forever.
 *
 * The sealed artifact format (the ONE format — ports must match):
 *   - random 12-byte IV;
 *   - blob = iv(12) ‖ tag(16) ‖ ct (AES-256-GCM, WebCrypto layout ct‖tag
 *     reassembled as tag‖ct for the split — see below);
 *   - b64u when embedded in this page.
 *
 * The decryption key travels ONLY in the URL `#fragment` (the publisher's
 * client generated it and never sent it anywhere). This page therefore
 * contains the ciphertext but NEVER the key — by construction the server
 * never saw it, and nothing here reads or transmits the fragment.
 *
 * Decryption: the fragment key (b64u 32 bytes) imports via WebCrypto; the
 * embedded blob splits iv/tag/ct; GCM auth runs BEFORE any render. On
 * success the artifact HTML lands in a SANDBOXED iframe via srcdoc (no
 * allow-scripts — the shared document renders, its own scripts never run).
 * On ANY failure — missing fragment, wrong key, tampered artifact — the error
 * surface shows and the iframe stays empty: no partial render, ever.
 */

/** Render the self-contained viewer page with the artifact embedded. */
export function renderShareViewer(ciphertextB64u: string): string {
  // The ciphertext is the only interpolated value — JSON-quoted so it can
  // never break out of the string literal.
  const embedded = JSON.stringify(ciphertextB64u);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shared page</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #ffffff; }
  #view { display: block; width: 100%; height: 100%; border: 0; }
  #err { display: none; max-width: 34rem; margin: 16vh auto 0; padding: 0 1.5rem;
         font: 400 0.9375rem/1.6 system-ui, sans-serif; color: #444; }
  #err h1 { font-size: 1.1rem; margin: 0 0 0.5rem; color: #222; }
</style>
</head>
<body>
<div id="err" role="alert"><h1>Couldn't open this share</h1><p id="errmsg"></p></div>
<iframe id="view" title="Shared page" sandbox=""></iframe>
<script>
(function () {
  "use strict";
  var ARTIFACT_B64U = ${embedded};
  var err = document.getElementById("err");
  var errmsg = document.getElementById("errmsg");
  var view = document.getElementById("view");

  function fail(message) {
    view.style.display = "none";
    errmsg.textContent = message;
    err.style.display = "block";
    document.title = "Share unavailable";
  }

  function b64uDecode(text) {
    var padded = text.replace(/-/g, "+").replace(/_/g, "/");
    var binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function main() {
    var keyText = location.hash.replace(/^#/, "");
    if (keyText === "") {
      return fail("This link is missing its key — the part after the # was dropped when it was copied. Ask the sender for the full link.");
    }
    try {
      var raw = b64uDecode(ARTIFACT_B64U);
      var keyBytes = b64uDecode(keyText);
      if (keyBytes.length !== 32) throw new Error("bad key length");
      var iv = raw.slice(0, 12);
      var tag = raw.slice(12, 28);
      var ct = raw.slice(28);
      // WebCrypto's AES-GCM wants ct ‖ tag; the artifact stores tag ‖ ct.
      var sealed = new Uint8Array(ct.length + tag.length);
      sealed.set(ct, 0);
      sealed.set(tag, ct.length);
      var key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
      var plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, sealed);
      view.srcdoc = new TextDecoder().decode(plain);
    } catch (e) {
      fail("The key doesn't match this share, or the share was tampered with. Ask the sender to re-publish it.");
    }
  }

  void main();
})();
</script>
</body>
</html>
`;
}
