import { useEffect, useRef, useState } from "react";
import { readThreadRecord } from "../../state";
import { recordFirstMessageVisible, recordThreadHoldEnd, recordThreadHoldStart } from "@/lib/thread-switch-telemetry";

/** Retains a populated outgoing transcript until the selected transcript can paint. */
export function useOutgoingTranscriptHold(
  activeThreadId: string | null,
  targetPaintable: boolean,
): string | null {
  const previousActiveThreadIdRef = useRef<string | null>(activeThreadId);
  const [heldOutgoingThreadId, setHeldOutgoingThreadId] = useState<string | null>(null);
  const previousThreadId = previousActiveThreadIdRef.current;
  const immediateHeldOutgoingThreadId =
    !targetPaintable
    && previousThreadId
    && previousThreadId !== activeThreadId
    && readThreadRecord(previousThreadId).messages.length > 0
      ? previousThreadId
      : null;
  const displayHoldThreadId = targetPaintable
    ? null
    : immediateHeldOutgoingThreadId ?? heldOutgoingThreadId;

  useEffect(() => {
    const outgoingThreadId = previousActiveThreadIdRef.current;
    previousActiveThreadIdRef.current = activeThreadId;
    if (
      targetPaintable
      || !activeThreadId
      || !outgoingThreadId
      || outgoingThreadId === activeThreadId
      || readThreadRecord(outgoingThreadId).messages.length === 0
    ) {
      setHeldOutgoingThreadId(null);
      return;
    }

    setHeldOutgoingThreadId(outgoingThreadId);
    recordThreadHoldStart(activeThreadId);
    const timeout = setTimeout(() => {
      setHeldOutgoingThreadId((heldThreadId) => {
        if (heldThreadId === outgoingThreadId) recordThreadHoldEnd(activeThreadId);
        return heldThreadId === outgoingThreadId ? null : heldThreadId;
      });
    }, 500);
    return () => clearTimeout(timeout);
  }, [activeThreadId, targetPaintable]);

  useEffect(() => {
    if (!activeThreadId || !targetPaintable) return;
    if (heldOutgoingThreadId) recordThreadHoldEnd(activeThreadId);
    recordFirstMessageVisible(activeThreadId);
  }, [activeThreadId, heldOutgoingThreadId, targetPaintable]);

  return displayHoldThreadId;
}
