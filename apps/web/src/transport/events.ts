export interface AgentStreamEvent {
  thread_id: string;
  event: {
    type: string;
    [key: string]: unknown;
  };
}

function isElectron(): boolean {
  return typeof window !== "undefined" && "electronAPI" in window;
}

// Tauri listener state
let tauriUnlisten: (() => void) | null = null;
let tauriGeneration = 0;

// Electron listener state
let electronUnlisten: (() => void) | null = null;
let electronGeneration = 0;

export async function startListening(
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  if (isElectron()) {
    const gen = ++electronGeneration;

    const removeListener = window.electronAPI!.on(
      "agent-event",
      (...args: unknown[]) => {
        if (gen !== electronGeneration) return;
        onEvent(args[0] as AgentStreamEvent);
      },
    );

    // If stopListening or another startListening ran while we were setting up,
    // discard this listener immediately to prevent duplicates.
    if (gen !== electronGeneration) {
      removeListener();
      return;
    }

    electronUnlisten = removeListener;
  } else {
    // Tauri path
    const gen = ++tauriGeneration;

    try {
      const { listen } = await import("@tauri-apps/api/event");

      const fn = await listen<AgentStreamEvent>("agent-event", (e) => {
        onEvent(e.payload);
      });

      // If stopListening or another startListening ran while we were awaiting,
      // discard this listener immediately to prevent duplicates.
      if (gen !== tauriGeneration) {
        fn();
        return;
      }

      tauriUnlisten = fn;
    } catch {
      // Not in Tauri environment
    }
  }
}

export function stopListening(): void {
  if (isElectron()) {
    electronGeneration++;
    if (electronUnlisten) {
      electronUnlisten();
      electronUnlisten = null;
    }
  } else {
    tauriGeneration++;
    if (tauriUnlisten) {
      tauriUnlisten();
      tauriUnlisten = null;
    }
  }
}
