// apps/web/src/lib/shortcuts.ts
//
// Thin integration layer: on each keydown, finds the matching keybinding,
// checks the "when" clause, and executes the associated command.

import {
  matchesKeyEvent,
  getKeybindings,
  getParsedKeybinding,
  loadKeybindings,
  type Keybinding,
} from "./keybinding-manager";
import { evaluateWhen, setContext } from "./context-tracker";
import { executeCommand } from "./command-registry";
import defaultKeybindings from "@/config/default-keybindings.json";

/** Detect whether an element is an input that should set the inputFocused context. */
function isInputElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/** Detect whether the active element is inside xterm. */
function isTerminalFocused(el: Element | null): boolean {
  if (!el) return false;
  return (
    !!el.closest(".xterm") ||
    el.classList.contains("xterm-helper-textarea")
  );
}

/** Update the inputFocused and terminalFocused context based on the active element. */
function updateFocusContext(): void {
  const active = document.activeElement;
  setContext("inputFocused", isInputElement(active));
  setContext("terminalFocused", isTerminalFocused(active));
}

function handleKeyDown(e: KeyboardEvent): void {
  // Refresh focus context right before matching so evaluateWhen
  // has up-to-date inputFocused / terminalFocused values.
  updateFocusContext();

  const bindings = getKeybindings();
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (matchesKeyEvent(getParsedKeybinding(i), e) && evaluateWhen(binding.when)) {
      if (executeCommand(binding.command)) {
        e.preventDefault();
        return;
      }
      // Command not registered; continue scanning for another binding on the same key
    }
  }
}

/**
 * Initialize the keybinding system.
 * Loads default keybindings (merged with optional user overrides),
 * attaches the global keydown listener, and sets up focus tracking.
 */
export function initShortcuts(overrides?: Keybinding[]): () => void {
  loadKeybindings(defaultKeybindings as Keybinding[], overrides);
  document.addEventListener("keydown", handleKeyDown);
  document.addEventListener("focusin", updateFocusContext);
  document.addEventListener("focusout", updateFocusContext);

  return () => {
    document.removeEventListener("keydown", handleKeyDown);
    document.removeEventListener("focusin", updateFocusContext);
    document.removeEventListener("focusout", updateFocusContext);
  };
}

/** Get all active keybindings. */
export { getKeybindings } from "./keybinding-manager";
/** Load keybindings from defaults and optional user overrides. */
export { loadKeybindings } from "./keybinding-manager";
/** Return all currently registered commands. */
export { getAllCommands } from "./command-registry";
/** Register a command and return a disposer that unregisters it. */
export { registerCommand } from "./command-registry";
