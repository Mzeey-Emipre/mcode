// apps/web/src/lib/shortcuts.ts
//
// Thin integration layer: on each keydown, finds the matching keybinding,
// checks the "when" clause, and executes the associated command.

import {
  parseKeybinding,
  matchesKeyEvent,
  getKeybindings,
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

  for (const binding of getKeybindings()) {
    const parsed = parseKeybinding(binding.key);
    if (matchesKeyEvent(parsed, e) && evaluateWhen(binding.when)) {
      e.preventDefault();
      executeCommand(binding.command);
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
