import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./ui/App.js";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("notees: #root element missing from index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
