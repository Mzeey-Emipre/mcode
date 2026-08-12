import { injectable } from "tsyringe";
import { LegacyTerminalBackend } from "./legacy/legacy-terminal-backend.js";
import type { TerminalBackend } from "./terminal-backend.js";

/** Selects one immutable Terminal backend before the server accepts requests. */
@injectable()
export class TerminalBackendSelector {
  private readonly selectedBackend: TerminalBackend;

  constructor(
    legacyBackend: LegacyTerminalBackend,
    modernBackend?: TerminalBackend,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.selectedBackend = env.MCODE_TERMINAL_BACKEND === "modern" && modernBackend
      ? modernBackend
      : legacyBackend;
  }

  /** Returns the Terminal backend selected for this server boot. */
  getSelectedBackend(): TerminalBackend {
    return this.selectedBackend;
  }
}
