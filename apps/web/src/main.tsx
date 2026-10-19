import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./ui/App.js";
import { DesignBridgeFixture } from "./ui/DesignBridgeFixture.js";

// The design-bridge fixture renders instead of the app: no auth, no sync,
// no workspace — a deterministic surface for the Playwright bridge spec
// (e2e/bridge-fixture.spec.ts). See DesignBridgeFixture.tsx.
const isDesignBridgeFixture = window.location.pathname === "/__design-bridge-fixture";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("notees: #root element missing from index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    {isDesignBridgeFixture ? <DesignBridgeFixture /> : <App />}
  </StrictMode>,
);
