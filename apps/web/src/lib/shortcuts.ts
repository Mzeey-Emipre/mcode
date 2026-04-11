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
  // Refresh focus context right before matching
  updateFocusContext();

  // Never intercept keystrokes when a terminal has focus
  if (isTerminalFocused(document.activeElement)) return;

  const bindings = getKeybindings();
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (matchesKeyEvent(getParsedKeybinding(i), e) && evaluateWhen(binding.when)) {
      const handled = executeCommand(binding.command);
      if (handled) e.preventDefault();
      return;
    }
  }
}

/**
 * Initialize the keybinding system.
 * Loads default keybindings, attaches the global keydown listener,
 * and sets up focus tracking.
 */
export function initShortcuts(): () => void {
  loadKeybindings(defaultKeybindings as Keybinding[]);
  document.addEventListener("keydown", handleKeyDown);
  document.addEventListener("focusin", updateFocusContext);
  document.addEventListener("focusout", updateFocusContext);

  return () => {
    document.removeEventListener("keydown", handleKeyDown);
    document.removeEventListener("focusin", updateFocusContext);
    document.removeEventListener("focusout", updateFocusContext);
  };
}

// Re-export for backward compat with tests and any remaining consumers
export { getKeybindings, loadKeybindings } from "./keybinding-manager";
export { getAllCommands, registerCommand } from "./command-registry";
