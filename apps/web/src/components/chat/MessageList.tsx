import { useRef, useEffect, useMemo, useCallback } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { MessageBubble } from "./MessageBubble";
import { ToolCallCard } from "./ToolCallCard";
import { StreamingIndicator } from "./StreamingIndicator";
import { StreamingBubble } from "./StreamingBubble";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ToolCall } from "@/transport/types";

const EMPTY_TOOL_CALLS: ToolCall[] = [];

export function MessageList() {
  const messages = useThreadStore((s) => s.messages);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const runningThreadIds = useThreadStore((s) => s.runningThreadIds);
  const agentStartTimes = useThreadStore((s) => s.agentStartTimes);
  const streamingText = useThreadStore((s) =>
    activeThreadId ? s.streamingByThread[activeThreadId] : undefined
  );
  const toolCallsRaw = useThreadStore((s) =>
    activeThreadId ? s.toolCallsByThread[activeThreadId] : undefined
  );
  const fadingToolCallsRaw = useThreadStore((s) =>
    activeThreadId ? s.fadingToolCallsByThread[activeThreadId] : undefined
  );
  const toolCalls = toolCallsRaw ?? EMPTY_TOOL_CALLS;
  const fadingToolCalls = fadingToolCallsRaw ?? EMPTY_TOOL_CALLS;
  const isAgentRunning = activeThreadId ? runningThreadIds.has(activeThreadId) : false;
  const agentStartTime = activeThreadId ? agentStartTimes[activeThreadId] : undefined;

  const hasActiveToolCalls = toolCalls.length > 0;
  const hasFadingToolCalls = fadingToolCalls.length > 0;
  const hasStreamingText = !!streamingText;

  // Split messages: render tool calls between the last user message and
  // the final assistant reply so they appear inline rather than at the bottom.
  const { beforeMessages, lastAssistantMsg } = useMemo(() => {
    const showToolCalls = hasActiveToolCalls || hasFadingToolCalls;
    if (!showToolCalls || messages.length === 0) {
      return { beforeMessages: messages, lastAssistantMsg: null };
    }
    // Find the last assistant message — tool calls belong just before it
    const lastIdx = messages.length - 1;
    const last = messages[lastIdx];
    if (last.role === "assistant") {
      return {
        beforeMessages: messages.slice(0, lastIdx),
        lastAssistantMsg: last,
      };
    }
    return { beforeMessages: messages, lastAssistantMsg: null };
  }, [messages, hasActiveToolCalls, hasFadingToolCalls]);

  // Throttled scroll-to-bottom: use instant during streaming to avoid jank,
  // smooth for discrete events. Throttle to at most once per 200ms.
  const scrollToBottom = useCallback((smooth: boolean) => {
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      bottomRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "instant" });
    }, 200);
  }, []);

  // Discrete events (new message, tool call) → smooth scroll
  useEffect(() => {
    scrollToBottom(true);
  }, [messages.length, toolCalls.length, isAgentRunning, scrollToBottom]);

  // Streaming deltas → throttled instant scroll
  useEffect(() => {
    if (streamingText) scrollToBottom(false);
  }, [streamingText, scrollToBottom]);

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-4">
        {beforeMessages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Active tool calls — inline between user message and assistant reply */}
        {hasActiveToolCalls && (
          <ToolCallCard toolCalls={toolCalls} />
        )}

        {/* Fading tool calls — completed calls lingering so user sees final state */}
        {hasFadingToolCalls && !hasActiveToolCalls && (
          <div className="animate-fade-out">
            <ToolCallCard toolCalls={fadingToolCalls} />
          </div>
        )}

        {/* The last assistant message renders after tool calls */}
        {lastAssistantMsg && (
          <MessageBubble key={lastAssistantMsg.id} message={lastAssistantMsg} />
        )}

        {/* Live streaming text — renders the response as it arrives */}
        {hasStreamingText && (
          <StreamingBubble content={streamingText} />
        )}

        {/* Streaming indicator with semantic phase labels */}
        {isAgentRunning && !hasStreamingText && (
          <StreamingIndicator startTime={agentStartTime} activeToolCalls={toolCalls} />
        )}

        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
