import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: {} }));
vi.mock("../../surfaces/registry.js", () => ({ findAdoptedWebContentsForWindow: vi.fn() }));
vi.mock("../../state/window-session.js", () => ({ getSession: vi.fn() }));

import {
  evaluateIsolatedExpression,
  inspectPageTarget,
  snapshotPage,
} from "../kernel.js";

class FakeElement {
  isConnected = true;
  textContent = "";
  type = "button";
  value = "";
  disabled = false;
  labels = undefined;
  parentElement = null;

  constructor(
    readonly tagName: string,
    private readonly attributes: Record<string, string>,
    private readonly rect: { x: number; y: number; width: number; height: number },
  ) {}

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  getBoundingClientRect() {
    return this.rect;
  }
}

function installDom(elements: FakeElement[]) {
  const query = () => Object.assign([...elements], {
    item: (index: number) => elements[index] ?? null,
  });
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLInputElement", FakeElement);
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible", display: "block" }));
  vi.stubGlobal("innerWidth", 1_000);
  vi.stubGlobal("innerHeight", 1_000);
  vi.stubGlobal("location", { href: "https://example.test/" });
  vi.stubGlobal("document", {
    body: null,
    title: "Example",
    readyState: "complete",
    querySelectorAll: query,
    getElementById: () => null,
    elementFromPoint: () => elements[0] ?? null,
  });
}

afterEach(() => {
  delete (globalThis as typeof globalThis & { __mcodeBrowserElements?: unknown }).__mcodeBrowserElements;
  vi.unstubAllGlobals();
});

describe("browser automation isolated-world identities", () => {
  it("survives reorder but makes removed and rerendered elements stale", () => {
    const first = new FakeElement("BUTTON", { "aria-label": "First" }, { x: 1, y: 2, width: 30, height: 20 });
    const second = new FakeElement("BUTTON", { "aria-label": "Second" }, { x: 40, y: 2, width: 30, height: 20 });
    const elements = [first, second];
    installDom(elements);

    const initial = snapshotPage({ semanticGeneration: 0, maxElements: 10, maxText: 100 });
    const firstId = initial.elements.find((element) => element.accessibleName === "First")!.semanticId;
    const secondId = initial.elements.find((element) => element.accessibleName === "Second")!.semanticId;

    elements.reverse();
    const reordered = snapshotPage({ semanticGeneration: 0, maxElements: 10, maxText: 100 });
    expect(reordered.elements.find((element) => element.accessibleName === "First")?.semanticId).toBe(firstId);
    expect(reordered.elements.find((element) => element.accessibleName === "Second")?.semanticId).toBe(secondId);

    first.isConnected = false;
    expect(inspectPageTarget({ target: { semanticId: firstId } })).toEqual({ attached: false, visible: false });

    const replacement = new FakeElement("BUTTON", { "aria-label": "First" }, { x: 1, y: 2, width: 30, height: 20 });
    elements.splice(elements.indexOf(first), 1, replacement);
    const rerendered = snapshotPage({ semanticGeneration: 0, maxElements: 10, maxText: 100 });
    const replacementId = rerendered.elements.find((element) => element.accessibleName === "First")!.semanticId;
    expect(replacementId).not.toBe(firstId);
    expect(inspectPageTarget({ target: { semanticId: firstId } })).toEqual({ attached: false, visible: false });
  });

  it("redacts values from semantically sensitive fields beyond password types", () => {
    const token = new FakeElement(
      "INPUT",
      { type: "text", name: "api_key", "aria-label": "Service token" },
      { x: 1, y: 2, width: 120, height: 20 },
    );
    token.type = "text";
    token.value = "raw-api-secret";
    const otp = new FakeElement(
      "INPUT",
      { type: "text", autocomplete: "one-time-code", placeholder: "Code" },
      { x: 1, y: 30, width: 120, height: 20 },
    );
    otp.type = "text";
    otp.value = "123456";
    const ordinary = new FakeElement(
      "INPUT",
      { type: "text", name: "display_name", "aria-label": "Display name" },
      { x: 1, y: 60, width: 120, height: 20 },
    );
    ordinary.type = "text";
    ordinary.value = "Ada";
    installDom([token, otp, ordinary]);

    const snapshot = snapshotPage({ semanticGeneration: 0, maxElements: 10, maxText: 100 });
    expect(snapshot.elements.map((element) => element.value)).toEqual([
      "[REDACTED]",
      "[REDACTED]",
      "Ada",
    ]);
  });

  it("treats hostile tags and input types as unmapped roles during snapshots and target inspection", () => {
    const hostileTag = new FakeElement("CONSTRUCTOR", { "aria-label": "Hostile tag" }, { x: 1, y: 2, width: 30, height: 20 });
    const hostileInput = new FakeElement("INPUT", { type: "__proto__", "aria-label": "Hostile input" }, { x: 40, y: 2, width: 30, height: 20 });
    installDom([hostileTag, hostileInput]);

    expect(snapshotPage({ semanticGeneration: 0, maxElements: 10, maxText: 100 }).elements).toEqual([
      expect.objectContaining({ role: "generic", accessibleName: "Hostile tag" }),
      expect.objectContaining({ role: "textbox", accessibleName: "Hostile input" }),
    ]);
    expect(inspectPageTarget({ target: { role: "generic", accessibleName: "Hostile tag" } })).toMatchObject({ attached: true, visible: true });
    expect(inspectPageTarget({ target: { role: "textbox", accessibleName: "Hostile input" } })).toMatchObject({ attached: true, visible: true });
  });

  it("preserves an empty aria-label ahead of a fallback alt label", () => {
    const labelled = new FakeElement("BUTTON", { "aria-label": "", alt: "Fallback label" }, { x: 1, y: 2, width: 30, height: 20 });
    installDom([labelled]);

    expect(snapshotPage({ semanticGeneration: 0, maxElements: 10, maxText: 100 }).elements[0]).toMatchObject({
      accessibleName: "",
    });
    expect(inspectPageTarget({ target: { role: "button", accessibleName: "" } })).toMatchObject({ attached: true, visible: true });
  });

  it("serializes cyclic and secret-bearing evaluation values inside the guest bound", async () => {
    const cyclic = await evaluateIsolatedExpression({
      expression: "(() => { const value = { token: 'secret' }; value.self = value; return value; })()",
      awaitPromise: true,
      maxBytes: 64 * 1_024,
    });
    expect(cyclic).toEqual({
      ok: true,
      valueJson: '{"token":"[REDACTED]","self":"[Circular]"}',
    });
    const huge = await evaluateIsolatedExpression({
      expression: "'x'.repeat(100000)",
      awaitPromise: false,
      maxBytes: 1_024,
    });
    expect(huge).toEqual({ ok: false, tooLarge: true });
  });

  it("redacts opaque cookie and storage values returned by evaluation", async () => {
    vi.stubGlobal("document", { cookie: "sid=opaque-cookie-value; theme=dark" });
    vi.stubGlobal("localStorage", {
      length: 1,
      key: () => "credential",
      getItem: () => "opaque-local-value",
    });
    vi.stubGlobal("sessionStorage", {
      length: 1,
      key: () => "credential",
      getItem: () => "opaque-session-value",
    });

    expect(evaluateIsolatedExpression({
      expression: "({ cookie: document.cookie, local: localStorage.getItem('credential'), nested: `prefix:${sessionStorage.getItem('credential')}` })",
      awaitPromise: false,
      maxBytes: 64 * 1_024,
    })).toEqual({
      ok: true,
      valueJson: '{"cookie":"[REDACTED]","local":"[REDACTED]","nested":"prefix:[REDACTED]"}',
    });
  });
});
