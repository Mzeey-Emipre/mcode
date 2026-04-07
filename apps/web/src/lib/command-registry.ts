/** Definition of a command in the registry. */
export interface CommandDefinition {
  /** Unique identifier (e.g., "thread.new", "sidebar.toggle"). */
  id: string;
  /** Human-readable label shown in the command palette. */
  title: string;
  /** Grouping category for palette display (e.g., "Navigation", "View"). */
  category: string;
  /** Function to execute when the command is invoked. */
  handler: () => void;
}

const commands = new Map<string, CommandDefinition>();

/**
 * Register a command in the global registry.
 * Returns a dispose function that unregisters the command when called.
 */
export function registerCommand(def: CommandDefinition): () => void {
  commands.set(def.id, def);
  return () => {
    commands.delete(def.id);
  };
}

/** Remove a command from the registry by ID. */
export function unregisterCommand(id: string): void {
  commands.delete(id);
}

/** Look up a registered command by ID. Returns undefined if not found. */
export function getCommand(id: string): CommandDefinition | undefined {
  return commands.get(id);
}

/** Return all currently registered commands. */
export function getAllCommands(): CommandDefinition[] {
  return Array.from(commands.values());
}

/**
 * Execute a command by ID.
 * Returns true if the command was found and executed, false otherwise.
 */
export function executeCommand(id: string): boolean {
  const cmd = commands.get(id);
  if (!cmd) return false;
  cmd.handler();
  return true;
}

/** Remove all registered commands. Intended for use in tests only. */
export function clearCommands(): void {
  commands.clear();
}
