import { useEffect } from "react";
import { getTransport } from "@/transport";
import { useConnectionStore } from "@/stores/connectionStore";

/** Subscribes an active workspace scope to server-owned local file invalidations. */
export function useWorkspaceFileInvalidation(
  workspaceId: string | null | undefined,
  threadId: string | null | undefined,
): void {
  const connectionStatus = useConnectionStore((state) => state.status);

  useEffect(() => {
    if (!workspaceId || connectionStatus !== "connected") return;
    void getTransport().watchWorkspaceFiles(workspaceId, threadId ?? undefined).catch((error: unknown) => {
      if (isConnectionRace(error)) return;
      console.error("[files] Failed to subscribe to workspace invalidation", error);
    });
  }, [connectionStatus, threadId, workspaceId]);
}

function isConnectionRace(error: unknown): boolean {
  return error instanceof Error && (error.message === "WebSocket disconnected" || error.message === "Transport closed");
}
