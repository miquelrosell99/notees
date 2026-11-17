import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/app";

const container = document.getElementById("root")!;

Office.onReady(() => {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}).catch((e: unknown) => {
  // The pane never heard from the Office host — say so instead of rendering a
  // blank pane (e.g. opened outside Word, or a host whose onReady rejected).
  container.textContent = "";
  const message = document.createElement("p");
  message.className = "pane-note";
  message.setAttribute("role", "alert");
  message.textContent = `The Notees pane could not start: ${
    e instanceof Error ? e.message : String(e)
  } — open it from a Word task pane.`;
  container.appendChild(message);
});
