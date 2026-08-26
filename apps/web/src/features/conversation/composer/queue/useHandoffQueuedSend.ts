import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MessageMention,
  OrchestrationMode,
  PreviewAnnotationBundle,
} from "@mcode/contracts";
import type { AttachmentMeta } from "@/transport";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";

type HandoffStatus = "generating" | "ready" | "fallback" | "error" | undefined;

/** A submit held until a child thread's handoff context is ready. */
export interface HandoffQueuedSend {
  content: string;
  displayContent: string;
  mentions: MessageMention[];
  previewAnnotations?: PreviewAnnotationBundle;
  goalObjective?: string;
  orchestrationMode?: OrchestrationMode;
  attachments: AttachmentMeta[];
  selection: ComposerAgentSelection;
  replyToMessageId?: string;
  quotedText?: string;
  browserCaptureSpillPaths?: string[];
}

/** Inputs that connect handoff state to the Composer's actual transport action. */
export interface UseHandoffQueuedSendOptions {
  threadId: string | undefined;
  handoffStatus: HandoffStatus;
  getCurrentHandoffStatus: () => HandoffStatus;
  onDispatch: (queued: HandoffQueuedSend) => void;
}

/** Defers one Composer submit until the handoff document for its child thread is available. */
export function useHandoffQueuedSend({
  threadId,
  handoffStatus,
  getCurrentHandoffStatus,
  onDispatch,
}: UseHandoffQueuedSendOptions): {
  queuedSend: HandoffQueuedSend | null;
  queueIfGenerating: (queued: HandoffQueuedSend) => boolean;
} {
  const [queuedSend, setQueuedSend] = useState<HandoffQueuedSend | null>(null);
  const [hasSeenHandoffTransition, setHasSeenHandoffTransition] = useState(false);
  const queuedSendRef = useRef<HandoffQueuedSend | null>(null);
  const onDispatchRef = useRef(onDispatch);
  queuedSendRef.current = queuedSend;
  onDispatchRef.current = onDispatch;

  useEffect(() => {
    setHasSeenHandoffTransition(false);
  }, [threadId]);

  useEffect(() => {
    if (handoffStatus && handoffStatus !== "generating") {
      setHasSeenHandoffTransition(true);
    }
  }, [handoffStatus]);

  const queueIfGenerating = useCallback(
    (queued: HandoffQueuedSend): boolean => {
      if (
        !threadId ||
        getCurrentHandoffStatus() !== "generating" ||
        !hasSeenHandoffTransition
      ) {
        return false;
      }
      setQueuedSend(queued);
      return true;
    },
    [getCurrentHandoffStatus, hasSeenHandoffTransition, threadId],
  );

  useEffect(() => {
    if (!threadId) return;
    if (handoffStatus !== "ready" && handoffStatus !== "fallback") return;
    const queued = queuedSendRef.current;
    if (!queued) return;
    setQueuedSend(null);
    onDispatchRef.current(queued);
  }, [handoffStatus, threadId]);

  return { queuedSend, queueIfGenerating };
}
