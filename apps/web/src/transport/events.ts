export interface AgentStreamEvent {
  thread_id: string;
  event: {
    type: string;
    [key: string]: unknown;
  };
}

let unlisten: (() => void) | null = null;

export async function startListening(
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  if (unlisten) return; // Already listening

  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<AgentStreamEvent>("agent-event", (e) => {
      onEvent(e.payload);
    });
  } catch {
    // Not in Tauri environment
  }
}

export function stopListening(): void {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}
