import type { BrowserSurfacePresentation } from "./BrowserSurfaceHost";

/** Gradient wash used at each Browser edge while an agent has control. */
export const BROWSER_CONTROL_EDGE_BACKGROUND_IMAGE = [
  "linear-gradient(to right, color-mix(in oklab, var(--primary) 26%, transparent), transparent 32px)",
  "linear-gradient(to left, color-mix(in oklab, var(--primary) 26%, transparent), transparent 32px)",
  "linear-gradient(to bottom, color-mix(in oklab, var(--primary) 26%, transparent), transparent 32px)",
  "linear-gradient(to top, color-mix(in oklab, var(--primary) 26%, transparent), transparent 32px)",
].join(", ");

/** Inner and outer Browser glow used while an agent has control. */
export const BROWSER_CONTROL_EDGE_BOX_SHADOW = [
  "inset 0 0 40px color-mix(in oklab, var(--primary) 30%, transparent)",
  "0 0 24px color-mix(in oklab, var(--primary) 28%, transparent)",
].join(", ");

/** Draws a click-through agent-control edge above a detached Browser surface. */
export class BrowserSurfaceControlIndicator {
  public readonly element: HTMLDivElement;
  private controlled = false;
  private presented = false;

  public constructor(documentRef: Document, root: HTMLElement | null) {
    this.element = documentRef.createElement("div");
    this.element.dataset.testid = "browser-surface-control-indicator";
    this.element.setAttribute("aria-hidden", "true");
    this.element.style.position = "fixed";
    this.element.style.left = "-20000px";
    this.element.style.top = "0";
    this.element.style.width = "1px";
    this.element.style.height = "1px";
    this.element.style.visibility = "hidden";
    this.element.style.pointerEvents = "none";
    this.element.style.backgroundImage = BROWSER_CONTROL_EDGE_BACKGROUND_IMAGE;
    this.element.style.boxShadow = BROWSER_CONTROL_EDGE_BOX_SHADOW;
    root?.appendChild(this.element);
  }

  /** Places the edge indicator one layer above its Browser surface. */
  public present(presentation: BrowserSurfacePresentation): void {
    this.presented = true;
    this.element.style.left = `${presentation.left}px`;
    this.element.style.top = `${presentation.top}px`;
    this.element.style.width = `${presentation.width}px`;
    this.element.style.height = `${presentation.height}px`;
    this.element.style.transformOrigin = "top left";
    this.element.style.transform = presentation.scale === undefined
      ? ""
      : `scale(${presentation.scale})`;
    this.element.style.zIndex = presentation.zIndex === undefined
      ? ""
      : String(presentation.zIndex + 1);
    const coveredLeft = presentation.coveredLeft ?? 0;
    this.element.style.borderRadius = coveredLeft > 0 ? "" : "var(--radius-md) 0 0 0";
    this.element.style.clipPath = coveredLeft > 0
      ? `inset(0px 0px 0px ${coveredLeft}px round 0px 0px 0px 0px)`
      : "";
    this.syncVisibility();
  }

  /** Shows the indicator only while the host grants agent control. */
  public setControlled(controlled: boolean): void {
    this.controlled = controlled;
    this.syncVisibility();
  }

  /** Hides the indicator without changing its control state. */
  public hide(): void {
    this.presented = false;
    this.syncVisibility();
  }

  /** Removes the indicator from its renderer host. */
  public dispose(): void {
    this.element.remove();
  }

  private syncVisibility(): void {
    this.element.style.visibility = this.controlled && this.presented
      ? "visible"
      : "hidden";
  }
}
