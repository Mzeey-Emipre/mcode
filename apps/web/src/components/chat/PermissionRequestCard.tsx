import { useState, useCallback } from "react";
import { Shield, ChevronDown, Check, X, Zap, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import type { PermissionDecision } from "@mcode/contracts";

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
  settled,
  decision,
}: PermissionRequestCardProps) {
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = useCallback(
    async (d: PermissionDecision) => {
      setResponding(true);
      try {
        setError(null);
        await getTransport().respondToPermission(requestId, d);
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
  const inputPreview =
    typeof input === "string" ? input : JSON.stringify(input, null, 2);

  // ── Settled (collapsed) state ──────────────────────────────────────────────
  if (settled && decision) {
    return (
      <div className="flex items-center gap-2 border-l-2 border-border/30 pl-3 py-1 text-xs text-muted-foreground/70">
        <Icon size={13} className="shrink-0 text-muted-foreground/50" />
        <span className="font-medium">{label}</span>
        <Badge variant={badgeVariantFor(decision)} size="sm" className="ml-1">
          {decisionLabel(decision)}
        </Badge>
      </div>
    );
  }

  // ── Pending state ──────────────────────────────────────────────────────────
  return (
    <div className="border-l-2 border-amber-500/60 pl-3 py-2 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400">
        <Icon size={13} className="shrink-0" />
        <span>Permission requested: {label}</span>
      </div>

      {/* Input preview */}
      <pre
        className={cn(
          "text-[0.7rem] leading-relaxed text-muted-foreground/80",
          "bg-muted/30 rounded px-2 py-1.5",
          "max-h-[120px] overflow-y-auto scrollbar-on-hover",
          "whitespace-pre-wrap break-all font-mono",
        )}
      >
        {inputPreview}
      </pre>

      {/* Controls */}
      <div className="flex items-center gap-1.5">
        {/* Allow dropdown — shows both options */}
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={responding}
            aria-label="Allow options"
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs font-medium",
              "bg-primary text-primary-foreground",
              "transition-colors hover:bg-primary/90",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              "disabled:pointer-events-none disabled:opacity-50",
              "select-none cursor-default",
            )}
          >
            <Check size={11} />
            Allow
            <ChevronDown size={10} className="opacity-70 -mr-0.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={4} className="min-w-[170px]">
            <DropdownMenuItem
              disabled={responding}
              onSelect={() => respond("allow")}
              className="gap-2"
            >
              <Zap size={12} className="text-amber-500 shrink-0" />
              <div className="flex flex-col">
                <span className="text-xs font-medium">Allow once</span>
                <span className="text-[10px] text-muted-foreground">Prompt again next time</span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={responding}
              onSelect={() => respond("allow-session")}
              className="gap-2"
            >
              <Clock size={12} className="text-blue-400 shrink-0" />
              <div className="flex flex-col">
                <span className="text-xs font-medium">Allow in session</span>
                <span className="text-[10px] text-muted-foreground">Skip prompts this session</span>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Deny — quiet by default, destructive on hover */}
        <Button
          variant="ghost"
          size="xs"
          disabled={responding}
          onClick={() => respond("deny")}
          className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1"
        >
          <X size={11} />
          Deny
        </Button>
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
