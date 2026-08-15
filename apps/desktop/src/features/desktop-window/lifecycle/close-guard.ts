import type { BrowserWindow } from "electron";

/** The native confirmation options used when active agents block close. */
export interface CloseGuardMessageBoxOptions {
  readonly type: "question";
  readonly title: string;
  readonly message: string;
  readonly buttons: readonly string[];
  readonly defaultId: number;
  readonly cancelId: number;
}

/** Dependencies used by the close confirmation policy. */
export interface CloseGuardDependencies {
  /** Return the number of active agents. */
  readonly getActiveAgentCount: () => Promise<number>;
  /** Show the native close confirmation. */
  readonly showMessageBox: (
    window: BrowserWindow,
    options: CloseGuardMessageBoxOptions,
  ) => Promise<{ readonly response: number }>;
  /** Continue application shutdown after confirmation. */
  readonly quit: () => void;
}

/** Attach active-agent close confirmation to one BrowserWindow. */
export function attachCloseGuard(
  window: BrowserWindow,
  dependencies: CloseGuardDependencies,
): void {
  let closeHandling = false;

  window.on("close", async (event) => {
    if (closeHandling) {
      event.preventDefault();
      return;
    }
    closeHandling = true;

    try {
      let count = 0;
      try {
        count = await dependencies.getActiveAgentCount();
      } catch {
        count = 0;
      }

      if (count > 0) {
        event.preventDefault();
        const plural = count === 1 ? " is" : "s are";
        const message =
          `${count} agent${plural} still working. ` +
          "They'll resume when you reopen Mcode.";

        const { response } = await dependencies.showMessageBox(window, {
          type: "question",
          title: "Agents Running",
          message,
          buttons: ["Continue", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });

        if (response === 0) dependencies.quit();
      }
    } finally {
      closeHandling = false;
    }
  });
}
