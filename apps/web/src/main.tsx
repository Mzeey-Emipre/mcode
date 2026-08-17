import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jetbrains-mono/index.css";
import { App } from "./app/App";
import { AppErrorBoundary } from "./app/AppErrorBoundary";
import { initTransport } from "./transport";
import { initDesktopPowerReporting } from "./lib/desktop-power";
import "./index.css";

/** Render an error fallback when transport initialization fails. */
function renderTransportError(root: HTMLElement, error: unknown): void {
  const message =
    error instanceof Error ? error.message : String(error);
  root.innerHTML = "";

  const container = document.createElement("div");
  container.style.cssText =
    "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "height:100vh;font-family:var(--font-sans);color:var(--foreground);background:var(--background);gap:1.6rem;padding:2.4rem;";

  const heading = document.createElement("h1");
  heading.textContent = "Failed to connect";
  heading.style.cssText = "margin:0;font-size:2.4rem;line-height:2.8rem;";

  const detail = document.createElement("p");
  detail.textContent = message;
  detail.style.cssText = "margin:0;color:var(--muted-foreground);max-width:48rem;text-align:center;font-size:1.4rem;line-height:1.6rem;";

  const button = document.createElement("button");
  button.textContent = "Retry";
  button.style.cssText =
    "height:3.2rem;padding:0 1.2rem;border-radius:var(--radius-lg);border:1px solid var(--border);background:var(--secondary);" +
    "color:var(--secondary-foreground);cursor:pointer;font-size:1.4rem;line-height:1.6rem;font-weight:500;";
  button.addEventListener("click", () => window.location.reload());

  container.append(heading, detail, button);
  root.appendChild(container);
}

/** Show a loading indicator while the transport connects. */
function renderConnecting(container: HTMLElement): void {
  const el = document.createElement("div");
  el.style.cssText =
    "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "height:100vh;font-family:var(--font-sans);color:var(--muted-foreground);background:var(--background);gap:1.2rem;";

  const spinner = document.createElement("div");
  spinner.style.cssText =
    "width:2.4rem;height:2.4rem;border:0.2rem solid var(--border);border-top-color:var(--muted-foreground);" +
    "border-radius:50%;animation:spin 0.8s linear infinite;";

  const style = document.createElement("style");
  style.textContent = "@keyframes spin{to{transform:rotate(360deg)}}";

  const label = document.createElement("p");
  label.textContent = "Connecting to server...";
  label.style.cssText = "margin:0;font-size:1.4rem;line-height:1.6rem;";

  el.append(spinner, label);
  container.append(style, el);
}

const root = document.getElementById("root")!;
document.documentElement.toggleAttribute(
  "data-mcode-desktop",
  Boolean(window.desktopBridge?.window),
);

// Show loading state immediately so the screen is never blank.
renderConnecting(root);

initTransport()
  .then(async () => {
    if (
      import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "profiling" ||
      import.meta.env.VITE_MCODE_PERFORMANCE_MODE === "production"
    ) {
      const fixtureBridge = await import("./performance/frontend-renderer-fixture-bridge");
      fixtureBridge.installFrontendRendererFixtureBridge();
    }
    // Desktop only: report running turns / open terminals to the main
    // process so it can hold a power save blocker while the server is busy.
    initDesktopPowerReporting();
    root.innerHTML = "";
    createRoot(root).render(
      <StrictMode>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </StrictMode>
    );
  })
  .catch((error: unknown) => {
    renderTransportError(root, error);
  });
