/** A keybinding entry from the JSON config. */
export interface Keybinding {
  /** Key combination string (e.g., "mod+k", "mod+shift+n", "Escape"). */
  key: string;
  /** Command ID to execute (e.g., "commandPalette.toggle"). Prefix with "-" to remove. */
  command: string;
  /** Optional context condition (e.g., "!inputFocused"). */
  when?: string;
}

/** Parsed representation of a key combination. */
export interface ParsedKeybinding {
  /** Whether the platform modifier (Ctrl on Windows/Linux, Cmd on macOS) is required. */
  mod: boolean;
  /** Whether the Shift modifier is required. */
  shift: boolean;
  /** Whether the Alt modifier is required. */
  alt: boolean;
  /** The normalized (lowercased) key character or name. */
  key: string;
}

let keybindings: Keybinding[] = [];

/**
 * Parse a keybinding string like "mod+shift+k" into its components.
 * "mod" maps to Ctrl (Windows/Linux) or Cmd (macOS) at match time.
 */
export function parseKeybinding(str: string): ParsedKeybinding {
  const parts = str.split("+");
  const key = parts.pop()!;
  const modifiers = parts.map((p) => p.toLowerCase());

  return {
    mod: modifiers.includes("mod"),
    shift: modifiers.includes("shift"),
    alt: modifiers.includes("alt"),
    key: key.toLowerCase(),
  };
}

/**
 * Test whether a KeyboardEvent matches a parsed keybinding.
 *
 * For letter keys (a-z), shift must match exactly to distinguish
 * mod+n from mod+shift+n. For non-letter keys (symbols, special keys),
 * shift is encoded in the key character itself (e.g., "?" vs "/")
 * so the shift modifier is not checked.
 */
export function matchesKeyEvent(
  parsed: ParsedKeybinding,
  event: KeyboardEvent,
): boolean {
  const modMatch = parsed.mod
    ? event.ctrlKey || event.metaKey
    : true;

  const altMatch = parsed.alt ? event.altKey : !event.altKey;

  const keyMatch = event.key.toLowerCase() === parsed.key;

  // For letter keys, enforce exact shift match to distinguish mod+n from mod+shift+n.
  // For symbols and special keys, shift state is implicit in the key value itself.
  const isLetter = /^[a-z]$/.test(parsed.key);
  const shiftMatch = isLetter
    ? parsed.shift === event.shiftKey
    : true;

  return modMatch && shiftMatch && altMatch && keyMatch;
}

/**
 * Load keybindings from defaults and optional user overrides.
 *
 * User overrides replace defaults by command ID. A user binding with
 * a command prefixed by "-" (e.g., "-thread.new") removes that command's
 * default binding entirely.
 */
export function loadKeybindings(
  defaults: Keybinding[],
  userOverrides?: Keybinding[],
): void {
  if (!userOverrides || userOverrides.length === 0) {
    keybindings = [...defaults];
    return;
  }

  // Collect removals and overrides from user bindings
  const removals = new Set<string>();
  const overrideMap = new Map<string, Keybinding>();

  for (const binding of userOverrides) {
    if (binding.command.startsWith("-")) {
      removals.add(binding.command.slice(1));
    } else {
      overrideMap.set(binding.command, binding);
    }
  }

  // Build merged list: defaults with user overrides applied
  const merged: Keybinding[] = [];
  for (const def of defaults) {
    if (removals.has(def.command)) continue;
    if (overrideMap.has(def.command)) {
      merged.push(overrideMap.get(def.command)!);
      overrideMap.delete(def.command);
    } else {
      merged.push(def);
    }
  }

  // Append any purely new user bindings that have no default counterpart
  for (const binding of overrideMap.values()) {
    merged.push(binding);
  }

  keybindings = merged;
}

/** Get all active keybindings. */
export function getKeybindings(): readonly Keybinding[] {
  return keybindings;
}

/** Find the keybinding for a given command ID. */
export function getKeybindingForCommand(
  commandId: string,
): Keybinding | undefined {
  return keybindings.find((b) => b.command === commandId);
}

/**
 * Format a keybinding string for display.
 *
 * @param key - Raw keybinding string (e.g., "mod+shift+n")
 * @param isMac - Whether to use Mac symbols (Cmd/⌘) or Windows labels (Ctrl+)
 */
export function formatKeybinding(key: string, isMac: boolean): string {
  const parts = key.split("+");
  const keyPart = parts.pop()!;
  const modifiers = parts.map((p) => p.toLowerCase());

  const segments: string[] = [];

  if (modifiers.includes("mod")) {
    segments.push(isMac ? "\u2318" : "Ctrl+");
  }
  if (modifiers.includes("shift")) {
    segments.push(isMac ? "\u21E7" : "Shift+");
  }
  if (modifiers.includes("alt")) {
    segments.push(isMac ? "\u2325" : "Alt+");
  }

  // Human-readable display names for special keys
  const keyDisplay: Record<string, string> = {
    escape: "Esc",
    backspace: "Backspace",
    enter: "Enter",
    "\\": "\\",
    ",": ",",
  };

  const displayKey =
    keyDisplay[keyPart.toLowerCase()] ?? keyPart.toUpperCase();
  segments.push(displayKey);

  return segments.join("");
}

/** Remove all keybindings (for testing). */
export function clearKeybindings(): void {
  keybindings = [];
}
