import { useEffect, useState } from "react";
import { Check, ChevronDown, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ContextWindowMode, ReasoningLevel } from "@mcode/contracts";
import { supports1MContextWindow, supportsThinkingToggle } from "@/lib/model-registry";
import { useThreadStore } from "@/stores/threadStore";
import { cn } from "@/lib/utils";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";

/** Defaults that model preferences use when no thread override exists. */
export interface ComposerModelPreferenceDefaults {
  contextWindow: ContextWindowMode | undefined;
  thinking: boolean | undefined;
  globalCodexFast: boolean;
}

/** Props for Composer model preference controls. */
export interface ComposerModelPreferencesProps {
  threadId?: string;
  branchFromMessageId?: string;
  show: boolean;
  selection: ComposerAgentSelection;
  defaults: ComposerModelPreferenceDefaults;
  reasoningLevels: ReasoningLevel[];
  onSelectionChange(patch: Partial<ComposerAgentSelection>): void;
}

interface ModelPreferenceState {
  has1M: boolean;
  hasThinking: boolean;
  hasCodexFast: boolean;
  contextWindow: ContextWindowMode;
  thinking: boolean;
  codexFastMode: boolean;
  reasoningLevels: ReasoningLevel[];
  preferenceLabel: string;
  preferenceTooltip: string;
  canShowPreferences: boolean;
}

interface ModelPreferenceActionProps {
  threadId: string | undefined;
  branchFromMessageId: string | undefined;
  selection: ComposerAgentSelection;
  defaults: ComposerModelPreferenceDefaults;
  onSelectionChange(patch: Partial<ComposerAgentSelection>): void;
}

function supportsClaudeModelOption(
  provider: ComposerAgentSelection["provider"],
  modelId: string,
  supportsOption: (modelId: string) => boolean,
): boolean {
  return provider === "claude" && supportsOption(modelId);
}

function getCodexFastMode(
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
): boolean {
  if (selection.codexFastMode === null) return defaults.globalCodexFast;
  return selection.codexFastMode;
}

function getContextWindow(
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
): ContextWindowMode {
  return selection.contextWindow ?? defaults.contextWindow ?? "200k";
}

function getThinking(
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
): boolean {
  return selection.thinking ?? defaults.thinking ?? false;
}

function hasAvailablePreference(
  reasoningLevels: ReasoningLevel[],
  has1M: boolean,
  hasThinking: boolean,
  hasCodexFast: boolean,
): boolean {
  return reasoningLevels.length > 0 || has1M || hasThinking || hasCodexFast;
}

function reasoningLabel(level: string): string {
  if (level === "xhigh") return "X-High";
  if (level === "none") return "None";
  if (level === "minimal") return "Minimal";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function getPreferenceLabel(state: Omit<ModelPreferenceState, "preferenceLabel" | "preferenceTooltip" | "canShowPreferences">, selection: ComposerAgentSelection): string {
  if (state.reasoningLevels.length > 0) return reasoningLabel(selection.reasoning);
  if (state.hasThinking) return "Thinking";
  if (state.hasCodexFast) return state.codexFastMode ? "Fast" : "Off";
  return state.contextWindow === "1m" ? "1M" : "200K";
}

function getPreferenceTooltip(
  reasoningLevels: ReasoningLevel[],
  has1M: boolean,
  hasThinking: boolean,
  hasCodexFast: boolean,
): string {
  if (reasoningLevels.length > 0) {
    if (has1M || hasThinking || hasCodexFast) return "Reasoning and model options";
    return "Reasoning level";
  }
  if (hasThinking) return "Thinking";
  if (hasCodexFast) return "Fast mode";
  return "Context window";
}

function getModelPreferenceState(
  selection: ComposerAgentSelection,
  defaults: ComposerModelPreferenceDefaults,
  reasoningLevels: ReasoningLevel[],
): ModelPreferenceState {
  const has1M = supportsClaudeModelOption(selection.provider, selection.modelId, supports1MContextWindow);
  const hasThinking = supportsClaudeModelOption(selection.provider, selection.modelId, supportsThinkingToggle);
  const hasCodexFast = selection.provider === "codex";
  const contextWindow = getContextWindow(selection, defaults);
  const thinking = getThinking(selection, defaults);
  const codexFastMode = getCodexFastMode(selection, defaults);
  const baseState = { has1M, hasThinking, hasCodexFast, contextWindow, thinking, codexFastMode, reasoningLevels };
  return {
    ...baseState,
    preferenceLabel: getPreferenceLabel(baseState, selection),
    preferenceTooltip: getPreferenceTooltip(reasoningLevels, has1M, hasThinking, hasCodexFast),
    canShowPreferences: hasAvailablePreference(reasoningLevels, has1M, hasThinking, hasCodexFast),
  };
}

function ComposerModelPreferencesTrigger({
  state,
  onClick,
}: {
  state: ModelPreferenceState;
  onClick(): void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
            className="gap-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            {state.hasCodexFast && state.codexFastMode && (
              <Zap
                size={12}
                strokeWidth={2.5}
                aria-hidden="true"
                data-testid="composer-fast-mode-icon"
                className="shrink-0 text-foreground/80"
              />
            )}
            <span className="text-sm">{state.preferenceLabel}</span>
            {state.reasoningLevels.length > 0 && state.has1M && state.contextWindow === "1m" && (
              <span
                data-testid="composer-1m-badge"
                className="rounded-sm bg-foreground/5 px-1 py-px text-xs font-medium uppercase tracking-wide text-foreground/80 ring-1 ring-inset ring-foreground/10 tabular-nums"
              >
                1M
              </span>
            )}
            <ChevronDown size={11} />
          </Button>
        }
      />
      <TooltipContent>{state.preferenceTooltip}</TooltipContent>
    </Tooltip>
  );
}

function ComposerReasoningOptions({
  state,
  actionProps,
}: {
  state: ModelPreferenceState;
  actionProps: ModelPreferenceActionProps;
}) {
  if (state.reasoningLevels.length === 0) return null;

  return (
    <>
      <div className="px-3 pt-1.5 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground/60 select-none">Reasoning effort</div>
      {state.reasoningLevels.map((reasoning) => (
        <button
          key={reasoning}
          onClick={() => {
            actionProps.onSelectionChange({ reasoning });
            if (actionProps.threadId) {
              void useThreadStore.getState().setThreadSettings(actionProps.threadId, { reasoningLevel: reasoning });
            }
          }}
          className={cn(
            "flex w-full items-center justify-between rounded px-3 py-1.5 text-xs",
            actionProps.selection.reasoning === reasoning
              ? "bg-accent text-foreground"
              : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <span>{reasoningLabel(reasoning)}</span>
          {actionProps.selection.reasoning === reasoning && <Check size={10} className="shrink-0 text-foreground" />}
        </button>
      ))}
    </>
  );
}

function ComposerContextWindowOptions({
  state,
  actionProps,
}: {
  state: ModelPreferenceState;
  actionProps: ModelPreferenceActionProps;
}) {
  if (!state.has1M) return null;

  return (
    <>
      {state.reasoningLevels.length > 0 && <div className="my-1 h-px bg-border/60" />}
      <div className="px-3 pt-1.5 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground/60 select-none">Context window</div>
      {(["200k", "1m"] as const).map((nextContextWindow) => (
        <button
          key={nextContextWindow}
          onClick={() => {
            actionProps.onSelectionChange({ contextWindow: nextContextWindow });
            if (actionProps.threadId && !actionProps.branchFromMessageId) {
              void useThreadStore.getState().setThreadSettings(actionProps.threadId, { contextWindow: nextContextWindow });
            }
          }}
          className={cn(
            "flex w-full items-center justify-between rounded px-3 py-1.5 text-xs",
            state.contextWindow === nextContextWindow
              ? "bg-accent text-foreground"
              : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <span className="tabular-nums">{nextContextWindow === "1m" ? "1M tokens" : "200K tokens"}</span>
          {state.contextWindow === nextContextWindow && <Check size={10} className="shrink-0 text-foreground" />}
        </button>
      ))}
    </>
  );
}

function ComposerThinkingOptions({
  state,
  actionProps,
}: {
  state: ModelPreferenceState;
  actionProps: ModelPreferenceActionProps;
}) {
  if (!state.hasThinking) return null;

  return (
    <>
      {(state.reasoningLevels.length > 0 || state.has1M) && <div className="my-1 h-px bg-border/60" />}
      <div className="px-3 pt-1.5 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground/60 select-none">Thinking</div>
      {[false, true].map((nextThinking) => (
        <button
          key={String(nextThinking)}
          onClick={() => {
            actionProps.onSelectionChange({ thinking: nextThinking });
            if (actionProps.threadId && !actionProps.branchFromMessageId) {
              void useThreadStore.getState().setThreadSettings(actionProps.threadId, { thinking: nextThinking });
            }
          }}
          className={cn(
            "flex w-full items-center justify-between rounded px-3 py-1.5 text-xs",
            state.thinking === nextThinking
              ? "bg-accent text-foreground"
              : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <span>{nextThinking ? "On" : "Off"}</span>
          {state.thinking === nextThinking && <Check size={10} className="shrink-0 text-foreground" />}
        </button>
      ))}
    </>
  );
}

function ComposerFastModeOption({
  state,
  actionProps,
}: {
  state: ModelPreferenceState;
  actionProps: ModelPreferenceActionProps;
}) {
  if (!state.hasCodexFast) return null;

  return (
    <>
      {(state.reasoningLevels.length > 0 || state.has1M || state.hasThinking) && <div className="my-1 h-px bg-border/60" />}
      <div className="px-3 pt-1.5 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground/60 select-none">Fast mode</div>
      <label
        className={cn(
          "flex w-full cursor-pointer items-center justify-between rounded px-3 py-1.5 text-xs",
          state.codexFastMode
            ? "bg-accent/50 text-foreground"
            : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
        )}
      >
        <span>Fast</span>
        <Switch
          data-testid="composer-codex-fast-switch"
          checked={state.codexFastMode}
          onCheckedChange={(checked) => {
            const codexFastMode = checked === actionProps.defaults.globalCodexFast ? null : checked;
            actionProps.onSelectionChange({ codexFastMode });
            if (actionProps.threadId && !actionProps.branchFromMessageId) {
              void useThreadStore.getState().setThreadSettings(actionProps.threadId, { codexFastMode });
            }
          }}
          aria-label="Fast mode"
          onClick={(event) => event.stopPropagation()}
        />
      </label>
    </>
  );
}

function ComposerModelPreferenceMenu({
  open,
  state,
  actionProps,
}: {
  open: boolean;
  state: ModelPreferenceState;
  actionProps: ModelPreferenceActionProps;
}) {
  if (!open) return null;

  return (
    <div
      onClick={(event) => event.stopPropagation()}
      className="absolute bottom-full left-0 z-20 mb-1 min-w-[224px] rounded-md border border-border bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1 duration-150"
    >
      <ComposerReasoningOptions state={state} actionProps={actionProps} />
      <ComposerContextWindowOptions state={state} actionProps={actionProps} />
      <ComposerThinkingOptions state={state} actionProps={actionProps} />
      <ComposerFastModeOption state={state} actionProps={actionProps} />
    </div>
  );
}

/** Owns the model preference menu and persists its selected thread settings. */
export function ComposerModelPreferences({
  threadId,
  branchFromMessageId,
  show,
  selection,
  defaults,
  reasoningLevels,
  onSelectionChange,
}: ComposerModelPreferencesProps) {
  const [showPreferences, setShowPreferences] = useState(false);
  const state = getModelPreferenceState(selection, defaults, reasoningLevels);
  const actionProps = { threadId, branchFromMessageId, selection, defaults, onSelectionChange };

  useEffect(() => {
    if (!state.canShowPreferences) setShowPreferences(false);
  }, [state.canShowPreferences]);

  useEffect(() => {
    const closePreferences = () => setShowPreferences(false);
    document.addEventListener("click", closePreferences);
    return () => document.removeEventListener("click", closePreferences);
  }, []);

  if (!show || !state.canShowPreferences) return null;

  return (
    <div className="relative">
      <ComposerModelPreferencesTrigger
        state={state}
        onClick={() => setShowPreferences((open) => !open)}
      />
      <ComposerModelPreferenceMenu open={showPreferences} state={state} actionProps={actionProps} />
    </div>
  );
}
