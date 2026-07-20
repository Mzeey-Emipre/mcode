/**
 * Tests for the CommandRow selection indicator in SlashCommandPopup.
 *
 * The selected row should use bg-accent as its only selection indicator.
 * The previous border-l-2 left-stripe must not appear on any row.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isTextNode,
  createEditor,
} from "lexical";
import { SlashCommandPopup } from "../SlashCommandPopup";
import type { Command } from "../useSlashCommand";
import { MentionNode } from "../lexical/MentionNode";
import { insertSelectedPluginMention } from "../lexical/SlashCommandPlugin";
import { extractComposerMessage } from "../lexical/cursor-utils";

// jsdom doesn't implement ResizeObserver or scrollIntoView. Capture originals
// so the polyfills are reverted after the suite to avoid leaking into other
// tests that share the same jsdom instance.
const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalVisualViewport = Object.getOwnPropertyDescriptor(
  window,
  "visualViewport",
);

beforeAll(() => {
  if (typeof window.ResizeObserver === "undefined") {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: { width: 1024, height: 768 },
  });
});

afterAll(() => {
  if (originalResizeObserver === undefined) {
    // @ts-expect-error -- intentional cleanup of polyfilled global
    delete globalThis.ResizeObserver;
  } else {
    globalThis.ResizeObserver = originalResizeObserver;
  }
  Element.prototype.scrollIntoView = originalScrollIntoView;
  if (originalVisualViewport) {
    Object.defineProperty(window, "visualViewport", originalVisualViewport);
  } else {
    // @ts-expect-error -- intentional cleanup of the test viewport
    delete window.visualViewport;
  }
});

/** Minimal DOMRect-like object for anchorRect. */
function makeAnchorRect(): DOMRect {
  return {
    top: 400,
    bottom: 420,
    left: 0,
    right: 320,
    width: 320,
    height: 20,
    x: 0,
    y: 400,
    toJSON() {
      return {};
    },
  };
}

const COMMANDS: Command[] = [
  { id: "command:foo", name: "foo", description: "First command", namespace: "command", capabilityKind: "providerCommand", nativeId: "foo" },
  { id: "skill:bar", name: "bar", description: "Second command", namespace: "skill", capabilityKind: "skill", nativeId: "bar" },
  { id: "mcode:baz", name: "baz", description: "Third command", namespace: "mcode", capabilityKind: "mcode", nativeId: "baz" },
];

const LONG_COMMANDS: Command[] = Array.from({ length: 25 }, (_, i) => ({
  id: `skill:${i}`,
  name: `skill-${i.toString().padStart(2, "0")}`,
  description: `Skill ${i}`,
  namespace: "skill",
  capabilityKind: "skill",
  nativeId: `skill-${i}`,
}));

function renderPopup(selectedIndex: number) {
  return render(
    <SlashCommandPopup
      state={{ kind: "ready", items: COMMANDS }}
      selectedIndex={selectedIndex}
      anchorRect={makeAnchorRect()}
      onSelect={() => {}}
      onDismiss={() => {}}
      onRetry={() => {}}
    />,
  );
}

function renderStatusPopup(state: "empty" | "loading" | "error") {
  return render(
    <SlashCommandPopup
      state={
        state === "error"
          ? { kind: "error", error: new Error("network failed") }
          : { kind: state }
      }
      selectedIndex={0}
      anchorRect={makeAnchorRect()}
      onSelect={() => {}}
      onDismiss={() => {}}
      onRetry={() => {}}
    />,
  );
}

function renderLongPopup() {
  return render(
    <SlashCommandPopup
      state={{ kind: "ready", items: LONG_COMMANDS }}
      selectedIndex={0}
      anchorRect={makeAnchorRect()}
      onSelect={() => {}}
      onDismiss={() => {}}
      onRetry={() => {}}
    />,
  );
}

describe("SlashCommandPopup selection indicator", () => {
  it("selected row has bg-accent class", () => {
    renderPopup(0);
    const selectedRow = screen.getByRole("option", { name: /foo/ });
    expect(selectedRow.className).toContain("bg-accent");
  });

  it("selected row has no border-l class", () => {
    renderPopup(0);
    const selectedRow = screen.getByRole("option", { name: /foo/ });
    expect(selectedRow.className).not.toMatch(/border-l/);
  });

  it("unselected row has no border-l class", () => {
    renderPopup(0);
    const unselectedRow = screen.getByRole("option", { name: /bar/ });
    expect(unselectedRow.className).not.toMatch(/border-l/);
  });

  it("selected row is marked aria-selected=true", () => {
    renderPopup(1);
    const selectedRow = screen.getByRole("option", { name: /bar/ });
    expect(selectedRow).toHaveAttribute("aria-selected", "true");
  });

  it("unselected rows are marked aria-selected=false", () => {
    renderPopup(1);
    const unselectedRow = screen.getByRole("option", { name: /foo/ });
    expect(unselectedRow).toHaveAttribute("aria-selected", "false");
  });

  it("renders long skill lists as ordinary rows", () => {
    renderLongPopup();
    expect(screen.getByRole("option", { name: /skill-00/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /skill-24/ })).toBeInTheDocument();
  });

  it("inserts a selected plugin as a rich mention", async () => {
    const editor = createEditor({ nodes: [MentionNode], onError: (error) => { throw error; } });
    let triggerKey = "";
    editor.update(() => {
      const paragraph = $createParagraphNode();
      const trigger = $createTextNode("/browser");
      triggerKey = trigger.getKey();
      paragraph.append(trigger);
      $getRoot().append(paragraph);
    }, { discrete: true });
    const plugin: Command = {
      id: "plugin:browser@openai-bundled",
      name: "Browser",
      description: "Control the in-app browser",
      namespace: "skill",
      capabilityKind: "plugin",
      nativeId: "browser@openai-bundled",
      mentionPath: "plugin://browser@openai-bundled",
    };
    render(
      <SlashCommandPopup
        state={{ kind: "ready", items: [plugin] }}
        selectedIndex={0}
        anchorRect={makeAnchorRect()}
        onSelect={(command) => {
          editor.update(() => {
            const trigger = $getNodeByKey(triggerKey);
            if ($isTextNode(trigger)) trigger.selectEnd();
          }, { discrete: true });
          insertSelectedPluginMention(editor, command);
        }}
        onDismiss={() => {}}
        onRetry={() => {}}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("option", { name: /@Browser/ }));

    await waitFor(() => expect(extractComposerMessage(editor)).toEqual({
      text: "@Browser ",
      mentions: [{
        id: expect.any(String),
        kind: "plugin",
        label: "Browser",
        name: "Browser",
        path: "plugin://browser@openai-bundled",
        range: { start: 0, end: 8 },
      }],
    }));
  });

  it.each([
    ["empty", "No commands match"],
    ["loading", "Loading commands..."],
    ["error", "Couldn't load commands: network failed"],
  ] as const)("positions the %s state above the anchor without overlap", (state, text) => {
    renderStatusPopup(state);
    const row =
      state === "error"
        ? screen.getByRole("alert")
        : screen.getByText(text).closest('[role="status"]');
    if (row === null) throw new Error(`${state} popup row not found`);
    const popup = row.closest("[data-slash-popup]") as HTMLElement;

    expect(popup.style.bottom).toBe("368px");
  });
});
