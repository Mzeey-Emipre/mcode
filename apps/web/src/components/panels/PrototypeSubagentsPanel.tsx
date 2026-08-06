import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { DeltaBlock } from "@/components/chat/narrative/DeltaBlock";
import { NarrativeFlow, type ThoughtSegment } from "@/components/chat/narrative";
import { NarrativeIndicator } from "@/components/chat/narrative/NarrativeIndicator";
import { TurnFooter } from "@/components/chat/narrative/TurnFooter";
import { SubagentIdentityGlyph } from "@/components/subagents/SubagentIdentityGlyph";
import {
  projectChildContinuationPrototypeRoster,
  useChildContinuationPrototypeStore,
  type ChildContinuationPrototypeRosterRow,
} from "@/stores/childContinuationPrototypeStore";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import type { Message, ToolCall } from "@/transport";

const PROTOTYPE_THREAD_ID = "prototype-child-continuation";
const SYNTHETIC_START_TIME = "2026-08-06T09:41:00.000Z";
const SYNTHETIC_TOOL_START = Date.parse(SYNTHETIC_START_TIME);
const CHILD_RESULT_TEXT = "Rollback is safe when the index is absent. The migration can be reverted without touching the new index shape.";
const ACTIVE_THOUGHT_BY_CHILD_STATE: Record<string, string> = {
  "rollback-check:working": "I’m checking whether the index is absent.",
  "schema-scan:started": "I’m preparing the initial checks.",
  "schema-scan:working": "I’m checking the migration boundary.",
  "test-runner:working": "I’m running the rollback tests.",
  "api-check:working": "I’m comparing the generated schema.",
};

function createTaskMessage(row: ChildContinuationPrototypeRosterRow): Message {
  return {
    id: `prototype-subagent-task-${row.id}`,
    thread_id: PROTOTYPE_THREAD_ID,
    role: "user",
    content: row.task,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: SYNTHETIC_START_TIME,
    sequence: 0,
    attachments: null,
  };
}

function createToolCalls(isActive: boolean): ToolCall[] {
  const readCall: ToolCall = {
    id: "prototype-subagent-read",
    toolName: "Read",
    toolInput: { file_path: "db/migrations/2026_08_add_index.sql" },
    output: "Migration boundary and index definition loaded.",
    isError: false,
    isComplete: true,
    startedAt: SYNTHETIC_TOOL_START + 2_000,
    elapsedSeconds: 5,
    durationMs: 5_000,
  };
  return [
    readCall,
    {
      id: "prototype-subagent-tests",
      toolName: "Bash",
      toolInput: { command: "pnpm test migration/rollback" },
      output: isActive ? null : "3 tests passed",
      isError: false,
      isComplete: !isActive,
      startedAt: SYNTHETIC_TOOL_START + 8_000,
      elapsedSeconds: 7,
      durationMs: isActive ? undefined : 7_000,
    },
  ];
}

function createThoughtSegments(row: ChildContinuationPrototypeRosterRow): ThoughtSegment[] {
  if (row.lifecycle === "finished") return [];
  return [{
    text: ACTIVE_THOUGHT_BY_CHILD_STATE[`${row.id}:${row.lifecycle}`] ?? "I’m reviewing the delegated task.",
    startedAt: SYNTHETIC_TOOL_START + 1_000,
  }];
}

function RosterRowButton({ row, onSelect }: { readonly row: ChildContinuationPrototypeRosterRow; readonly onSelect: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onSelect}
      aria-label={`Open ${row.identity} details`}
      data-subagent-id={row.id}
      data-testid="prototype-subagent-roster-row"
      className="h-auto w-full min-w-0 justify-start gap-3 rounded-none px-6 py-2.5 text-left transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/30 focus-visible:ring-inset"
    >
      <SubagentIdentityGlyph identity={row.identity} hasExplicitIdentity className="size-6" size={15} />
      <span className="min-w-0 flex-1">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{row.identity}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{row.activity}</span>
      </span>
    </Button>
  );
}

function PrototypeRosterDetail({ row, onBack }: { readonly row: ChildContinuationPrototypeRosterRow; readonly onBack: () => void }) {
  const isActive = row.lifecycle !== "finished";
  const [startTime] = useState(() => Date.now());
  const toolCalls = createToolCalls(isActive);
  const thoughtSegments = createThoughtSegments(row);
  const isAgentRunning = toolCalls.some((toolCall) => !toolCall.isComplete);
  const completedStepCount = toolCalls.filter((toolCall) => toolCall.isComplete).length;
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={`${row.identity} subagent details`}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-3">
        <Button type="button" variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to subagents" className="shrink-0">
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <SubagentIdentityGlyph identity={row.identity} hasExplicitIdentity className="size-6" size={14} />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{row.identity}</h2>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className={`${PRIMARY_CONTENT_RAIL_CLASS} px-6 py-8 sm:px-10`}>
          <MessageBubble message={createTaskMessage(row)} interactive={false} />
          <NarrativeFlow
            toolCalls={toolCalls}
            hooks={[]}
            thoughtSegments={thoughtSegments}
            streamingText=""
            isAgentRunning={isAgentRunning}
          />
          {isActive && (
            <NarrativeIndicator
              stepCount={completedStepCount}
              subagentCount={0}
              activeToolCalls={[]}
              startTime={startTime}
              isAgentRunning
            />
          )}
          {!isAgentRunning && (
            <div data-testid="prototype-subagent-response-text" className="mt-8 text-sm text-foreground">
              <DeltaBlock text={CHILD_RESULT_TEXT} isStreaming={false} showCursor={false} />
            </div>
          )}
          {!isActive && (
            <TurnFooter counts={{ steps: toolCalls.length, thoughts: 0, subagents: 0 }} durationMs={12_000} />
          )}
        </div>
      </ScrollArea>
    </section>
  );
}

/** DEV-only roster hosted by Mcode's real Subagents right-panel tab. */
export function PrototypeSubagentsPanel() {
  const state = useChildContinuationPrototypeStore((current) => current);
  const roster = projectChildContinuationPrototypeRoster(state);
  const selectedRow = [...roster.active, ...roster.finished].find((row) => row.id === state.selectedChildId);

  if (selectedRow) {
    return (
      <div data-testid="prototype-subagents-panel" className="flex min-h-0 flex-1 flex-col">
        <PrototypeRosterDetail row={selectedRow} onBack={() => state.selectChild(null)} />
      </div>
    );
  }

  return (
    <section data-testid="prototype-subagents-panel" className="flex min-h-0 flex-1 flex-col" aria-label="Subagents">
      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-3">
          <section aria-labelledby="prototype-subagents-active-heading">
            <div className="flex items-center gap-2 px-6 pb-1 pt-6">
              <h2 id="prototype-subagents-active-heading" className="text-sm font-semibold text-foreground">Active</h2>
              <Badge variant="ghost" size="sm" className="px-0 font-mono font-normal text-muted-foreground hover:bg-transparent">{roster.active.length}</Badge>
            </div>
            {roster.active.map((row) => <RosterRowButton key={row.id} row={row} onSelect={() => state.selectChild(row.id)} />)}
          </section>
          <section aria-labelledby="prototype-subagents-done-heading">
            <div className="flex items-center gap-2 px-6 pb-1 pt-6">
              <h2 id="prototype-subagents-done-heading" className="text-sm font-semibold text-foreground">Done</h2>
              <Badge variant="ghost" size="sm" className="px-0 font-mono font-normal text-muted-foreground hover:bg-transparent">{roster.finished.length}</Badge>
            </div>
            {roster.finished.map((row) => <RosterRowButton key={row.id} row={row} onSelect={() => state.selectChild(row.id)} />)}
          </section>
        </div>
      </ScrollArea>
    </section>
  );
}
