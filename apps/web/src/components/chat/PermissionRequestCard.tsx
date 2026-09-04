import { useState, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { Shield, ChevronDown, Check, X, Zap, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { getTransport } from "@/transport";
import { TOOL_ICONS } from "./tool-renderers/constants";
import type {
  PermissionDecision,
  PermissionQuestion,
  PermissionResponseAnswers,
} from "@mcode/contracts";

/** Props for {@link PermissionRequestCard}. */
interface PermissionRequestCardProps {
  /** Unique identifier for the permission request. */
  requestId: string;
  /** The tool name that is requesting permission. */
  toolName: string;
  /** Raw tool input arguments; shape varies by tool. */
  input: unknown;
  /** Optional human-readable title for the permission request. */
  title?: string;
  /** Questions that must be answered before the provider can continue. */
  questions?: PermissionQuestion[];
  /** Whether this request has already been resolved. */
  settled: boolean;
  /** The user's decision, present when settled. */
  decision?: PermissionDecision;
}

/** Maps a PermissionDecision to its Badge variant. */
function badgeVariantFor(
  decision: PermissionDecision,
): "default" | "destructive" | "secondary" | "outline" {
  if (decision === "allow" || decision === "allow-session") return "default";
  if (decision === "deny") return "destructive";
  return "outline";
}

/** Maps a PermissionDecision to its display label. */
function decisionLabel(decision: PermissionDecision): string {
  switch (decision) {
    case "allow":
      return "Allowed once";
    case "allow-session":
      return "Allowed in session";
    case "deny":
      return "Denied";
    case "cancelled":
      return "Cancelled";
  }
}

function SettledPermissionRequest({ icon, label, decision }: { icon: ReactNode; label: string; decision: PermissionDecision }) {
  return (
    <div className="flex items-center gap-2 border-l-2 border-border/30 pl-3 py-1 text-xs text-muted-foreground/70">
      {icon}
      <span className="font-medium">{label}</span>
      <Badge variant={badgeVariantFor(decision)} size="sm" className="ml-1">
        {decisionLabel(decision)}
      </Badge>
    </div>
  );
}

function PendingPermissionRequest({
  icon,
  label,
  inputPreview,
  responding,
  ready,
  allowMode,
  error,
  onRespond,
  onAllowMode,
}: {
  icon: ReactNode;
  label: string;
  inputPreview: string | undefined;
  responding: boolean;
  ready: boolean;
  allowMode: "allow" | "allow-session";
  error: string | null;
  onRespond: (decision: PermissionDecision) => void;
  onAllowMode: (mode: "allow" | "allow-session") => void;
}) {
  const controlsDisabled = responding || !ready;
  return (
    <div className="border-l-2 border-amber-500/60 pl-3 py-2 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400">
        {icon}
        <span>Permission requested: {label}</span>
      </div>
      <pre className={cn("text-xs leading-relaxed text-muted-foreground/80", "bg-muted/30 rounded px-2 py-1.5", "max-h-[120px] overflow-y-auto scrollbar-on-hover", "whitespace-pre-wrap break-all font-mono")}>
        {inputPreview}
      </pre>
      <div className="flex items-center gap-2">
        <div className="flex items-stretch rounded-md overflow-hidden">
          <button
            disabled={controlsDisabled}
            onClick={() => onRespond(allowMode)}
            className={cn("inline-flex h-6 items-center gap-1 pl-2 pr-2 text-xs font-medium", "bg-primary text-primary-foreground", "hover:bg-primary/90 transition-colors", "cursor-pointer disabled:pointer-events-none disabled:opacity-50")}
          >
            {allowMode === "allow" ? <Check size={11} /> : <Clock size={11} />}
            {allowMode === "allow" ? "Allow" : "Allow in session"}
          </button>
          <div className="w-px bg-primary-foreground/20 self-stretch" />
          <DropdownMenu>
            <DropdownMenuTrigger disabled={controlsDisabled} aria-label="Change allow mode" className={cn("inline-flex h-6 w-6 items-center justify-center", "bg-primary text-primary-foreground", "hover:bg-primary/90 transition-colors", "outline-none focus-visible:ring-2 focus-visible:ring-ring/50", "cursor-pointer disabled:pointer-events-none disabled:opacity-50")}>
              <ChevronDown size={11} className="opacity-80" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={4} className="min-w-[180px]">
              <DropdownMenuItem onClick={() => onAllowMode("allow")} className="gap-2">
                <Zap size={12} className="text-amber-500 shrink-0" />
                <div className="flex flex-col"><span className="text-xs font-medium">Allow once</span><span className="text-xs text-muted-foreground">Prompt again next time</span></div>
                {allowMode === "allow" && <Check size={11} className="ml-auto text-primary" />}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onAllowMode("allow-session")} className="gap-2">
                <Clock size={12} className="text-blue-400 shrink-0" />
                <div className="flex flex-col"><span className="text-xs font-medium">Allow in session</span><span className="text-xs text-muted-foreground">Skip prompts this session</span></div>
                {allowMode === "allow-session" && <Check size={11} className="ml-auto text-primary" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <button disabled={controlsDisabled} onClick={() => onRespond("deny")} className={cn("inline-flex h-6 items-center gap-1 px-2 text-xs font-medium rounded-md", "text-muted-foreground/70 hover:text-destructive", "hover:bg-destructive/10 transition-colors", "cursor-pointer disabled:pointer-events-none disabled:opacity-50")}>
          <X size={11} />
          Deny
        </button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function PendingQuestionRequest({
  requestId,
  icon,
  label,
  questions,
  responding,
  ready,
  error,
  onRespond,
}: {
  requestId: string;
  icon: ReactNode;
  label: string;
  questions: PermissionQuestion[];
  responding: boolean;
  ready: boolean;
  error: string | null;
  onRespond: (decision: PermissionDecision, answers?: PermissionResponseAnswers) => void;
}) {
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => ""));
  const controlsDisabled = responding || !ready;
  const answers = useMemo<PermissionResponseAnswers | undefined>(() => {
    const next = questions.map((question, index) => {
      const customAnswer = custom[index] ?? "";
      if (!customAnswer.trim()) return selected[index] ?? [];
      return question.multiple ? [...(selected[index] ?? []), customAnswer] : [customAnswer];
    });
    return next.every((answer) => answer.length > 0) ? next : undefined;
  }, [custom, questions, selected]);

  const selectOption = (questionIndex: number, option: string, multiple: boolean) => {
    setSelected((current) => current.map((answer, index) => {
      if (index !== questionIndex) return answer;
      if (!multiple) return [option];
      return answer.includes(option) ? answer.filter((item) => item !== option) : [...answer, option];
    }));
    if (!multiple) {
      setCustom((current) => current.map((answer, index) => (index === questionIndex ? "" : answer)));
    }
  };

  return (
    <div className="border-l-2 border-amber-500/60 pl-3 py-2 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400">
        {icon}
        <span>Answer required: {label}</span>
      </div>
      {questions.map((question, questionIndex) => (
        <fieldset key={`${question.header}-${questionIndex}`} className="flex flex-col gap-1.5">
          <legend className="text-xs font-medium">{question.header}</legend>
          <p className="text-sm text-foreground/90">{question.question}</p>
          {question.options.map((option) => {
            const checked = (selected[questionIndex] ?? []).includes(option.label);
            return (
              <label key={option.label} className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/40">
                <input
                  type={question.multiple ? "checkbox" : "radio"}
                  name={`question-${requestId}-${questionIndex}`}
                  checked={checked}
                  disabled={controlsDisabled}
                  onChange={() => selectOption(questionIndex, option.label, question.multiple)}
                />
                <span>
                  {option.label}
                  {option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}
                </span>
              </label>
            );
          })}
          {question.custom && (
            <input
              aria-label={`Custom answer for ${question.header}`}
              disabled={controlsDisabled}
              value={custom[questionIndex] ?? ""}
              onChange={(event) => setCustom((current) => current.map((answer, index) => (
                index === questionIndex ? event.target.value : answer
              )))}
              placeholder="Your answer"
              className="h-7 rounded border bg-background px-2 text-sm"
            />
          )}
        </fieldset>
      ))}
      <div className="flex items-center gap-2">
        <button
          disabled={controlsDisabled || !answers}
          onClick={() => answers && onRespond("allow", answers)}
          className={cn("inline-flex h-6 items-center gap-1 px-2 text-xs font-medium rounded-md", "bg-primary text-primary-foreground hover:bg-primary/90 transition-colors", "cursor-pointer disabled:pointer-events-none disabled:opacity-50")}
        >
          <Check size={11} />
          Submit answers
        </button>
        <button disabled={controlsDisabled} onClick={() => onRespond("deny")} className={cn("inline-flex h-6 items-center gap-1 px-2 text-xs font-medium rounded-md", "text-muted-foreground/70 hover:text-destructive", "hover:bg-destructive/10 transition-colors", "cursor-pointer disabled:pointer-events-none disabled:opacity-50")}>
          <X size={11} />
          Deny
        </button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * Renders an inline permission request card inside the chat message list.
 *
 * In the pending state it shows the tool name, an input preview, and an Allow
 * dropdown (Allow once / Allow in session) plus a Deny button. Once resolved
 * it collapses to a single line with an outcome badge.
 */
export function PermissionRequestCard({
  requestId,
  toolName,
  input,
  title,
  questions,
  settled,
  decision,
}: PermissionRequestCardProps) {
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks which allow mode is active — dropdown picks the mode, primary button fires it.
  const [allowMode, setAllowMode] = useState<"allow" | "allow-session">("allow");
  // Guard against accidental clicks caused by the card appearing under the cursor.
  // Buttons are disabled for 600ms after the card mounts so layout shifts don't
  // register as intentional clicks.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 600);
    return () => clearTimeout(t);
  }, []);

  const respond = useCallback(
    async (d: PermissionDecision, answers?: PermissionResponseAnswers) => {
      setResponding(true);
      try {
        setError(null);
        if (answers === undefined) await getTransport().respondToPermission(requestId, d);
        else await getTransport().respondToPermission(requestId, d, answers);
      } catch {
        setError("Failed to send response. Please try again.");
      } finally {
        setResponding(false);
      }
    },
    [requestId],
  );

  const Icon = TOOL_ICONS[toolName] ?? Shield;
  const label = title ?? toolName;
  const inputPreview = useMemo(
    () => (typeof input === "string" ? input : JSON.stringify(input, null, 2)),
    [input],
  );

  if (settled && decision) {
    return <SettledPermissionRequest icon={<Icon size={13} className="shrink-0 text-muted-foreground/50" />} label={label} decision={decision} />;
  }
  if (questions) {
    return <PendingQuestionRequest requestId={requestId} icon={<Icon size={13} className="shrink-0" />} label={label} questions={questions} responding={responding} ready={ready} error={error} onRespond={respond} />;
  }
  return <PendingPermissionRequest icon={<Icon size={13} className="shrink-0" />} label={label} inputPreview={inputPreview} responding={responding} ready={ready} allowMode={allowMode} error={error} onRespond={respond} onAllowMode={setAllowMode} />;
}
