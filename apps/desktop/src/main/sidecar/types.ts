/**
 * SidecarEvent discriminated union.
 * Defines the typed events emitted by SidecarClient.
 */

/** Discriminated union matching the Rust SidecarEvent enum (serde tag = "method", content = "params"). */
export type SidecarEvent =
  | {
      method: "session.message";
      params: {
        sessionId: string;
        type: string;
        content: string;
        messageId: string | null;
        tokens: number | null;
      };
    }
  | {
      method: "session.delta";
      params: {
        sessionId: string;
        text: string;
      };
    }
  | {
      method: "session.turnComplete";
      params: {
        sessionId: string;
        reason: string;
        costUsd: number | null;
        totalTokensIn: number | null;
        totalTokensOut: number | null;
      };
    }
  | {
      method: "session.error";
      params: {
        sessionId: string;
        error: string;
      };
    }
  | {
      method: "session.ended";
      params: {
        sessionId: string;
      };
    }
  | {
      method: "session.system";
      params: {
        sessionId: string;
        subtype: string;
      };
    }
  | {
      method: "session.toolUse";
      params: {
        sessionId: string;
        toolCallId: string | null;
        toolName: string;
        toolInput: Record<string, unknown>;
      };
    }
  | {
      method: "session.toolResult";
      params: {
        sessionId: string;
        toolCallId: string | null;
        output: string;
        isError: boolean;
      };
    };

/** Extract the session ID from a sidecar event. */
export function sessionIdFromEvent(event: SidecarEvent): string | null {
  return (event.params as { sessionId?: string }).sessionId ?? null;
}
