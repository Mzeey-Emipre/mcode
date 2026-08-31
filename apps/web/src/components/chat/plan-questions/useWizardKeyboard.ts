import { useEffect } from "react";

/** Discriminated action union returned by the key resolver. */
export type WizardKeyAction =
  | { type: "selectOption"; index: number }
  | { type: "advance" }
  | { type: "previous" }
  | { type: "deselect" }
  | { type: "cancel" };

function isTextInput(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return element?.tagName === "TEXTAREA" ||
    element?.tagName === "INPUT" ||
    element?.isContentEditable === true;
}

function resolveUniversalKeyAction(key: string, altKey: boolean, hasSelection: boolean): WizardKeyAction | null {
  if (altKey && key === "ArrowLeft") return { type: "previous" };
  if (key === "Escape") return hasSelection ? { type: "deselect" } : { type: "cancel" };
  return null;
}

function resolveNumberKeyAction(key: string, optionCount: number): WizardKeyAction | null {
  if (!/^[1-5]$/.test(key)) return null;
  const number = Number(key);
  if (number > optionCount) return null;
  return { type: "selectOption", index: number - 1 };
}

function resolveArrowKeyAction(key: string, optionCount: number, selectedIndex: number): WizardKeyAction | null {
  const isForward = key === "ArrowDown" || key === "ArrowRight";
  const isBackward = key === "ArrowUp" || key === "ArrowLeft";
  if (!isForward && !isBackward) return null;
  if (selectedIndex < 0) return { type: "selectOption", index: 0 };
  const nextIndex = isForward
    ? (selectedIndex + 1) % optionCount
    : (selectedIndex - 1 + optionCount) % optionCount;
  return { type: "selectOption", index: nextIndex };
}

/**
 * Pure function: given a keyboard event and wizard state, returns
 * the action to take or null if the key is not handled.
 */
export function resolveWizardKeyAction(
  e: KeyboardEvent,
  optionCount: number,
  selectedIndex: number,
  hasSelection: boolean,
): WizardKeyAction | null {
  const universalAction = resolveUniversalKeyAction(e.key, e.altKey, hasSelection);
  if (universalAction) return universalAction;
  if (isTextInput(e.target)) return null;
  if (e.key === "Enter") return { type: "advance" };
  if (e.key === "Backspace") return { type: "previous" };
  return resolveNumberKeyAction(e.key, optionCount)
    ?? resolveArrowKeyAction(e.key, optionCount, selectedIndex);
}

interface UseWizardKeyboardOptions {
  /** Whether the keyboard shortcuts are active. */
  enabled: boolean;
  /** Total number of option tiles (including the "Other" tile). */
  optionCount: number;
  /** Currently focused option index (0-based). -1 if none. */
  selectedIndex: number;
  /** Whether any option is currently selected. */
  hasSelection: boolean;
  /** Called when a number key or arrow selects an option by index. */
  onSelectOption: (index: number) => void;
  /** Advance to next question or submit on last. */
  onAdvance: () => void;
  /** Go to previous question. */
  onPrevious: () => void;
  /** Deselect the current option. */
  onDeselect: () => void;
  /** Cancel the wizard entirely. */
  onCancel: () => void;
}

/**
 * Attaches a global keydown listener for wizard keyboard shortcuts.
 * Delegates to `resolveWizardKeyAction` for the pure key-to-action mapping.
 */
export function useWizardKeyboard({
  enabled,
  optionCount,
  selectedIndex,
  hasSelection,
  onSelectOption,
  onAdvance,
  onPrevious,
  onDeselect,
  onCancel,
}: UseWizardKeyboardOptions): void {
  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      const action = resolveWizardKeyAction(e, optionCount, selectedIndex, hasSelection);
      if (!action) return;
      e.preventDefault();

      switch (action.type) {
        case "selectOption":
          onSelectOption(action.index);
          break;
        case "advance":
          onAdvance();
          break;
        case "previous":
          onPrevious();
          break;
        case "deselect":
          onDeselect();
          break;
        case "cancel":
          onCancel();
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, optionCount, selectedIndex, hasSelection, onSelectOption, onAdvance, onPrevious, onDeselect, onCancel]);
}
