import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { initTransport } from "./transport";
import "./index.css";

/** Render an error fallback when transport initialization fails. */
function renderTransportError(root: HTMLElement, error: unknown): void {
  const message =
    error instanceof Error ? error.message : String(error);
  root.innerHTML = "";

  const container = document.createElement("div");
  container.style.cssText =
    "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "height:100vh;font-family:system-ui,sans-serif;color:#e5e5e5;background:#18181b;gap:16px;padding:24px;";

  const heading = document.createElement("h1");
  heading.textContent = "Failed to connect";
  heading.style.cssText = "margin:0;font-size:1.5rem;";

  const detail = document.createElement("p");
  detail.textContent = message;
  detail.style.cssText = "margin:0;color:#a1a1aa;max-width:480px;text-align:center;";

  const button = document.createElement("button");
  button.textContent = "Retry";
  button.style.cssText =
    "padding:8px 20px;border-radius:6px;border:1px solid #3f3f46;background:#27272a;" +
    "color:#e5e5e5;cursor:pointer;font-size:0.875rem;";
  button.addEventListener("click", () => window.location.reload());

  container.append(heading, detail, button);
  root.appendChild(container);
}

const root = document.getElementById("root")!;

initTransport()
  .then(() => {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  })
  .catch((error: unknown) => {
    renderTransportError(root, error);
  });
