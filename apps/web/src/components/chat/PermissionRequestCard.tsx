import { useState, useCallback } from "react";
import { Shield, ChevronDown, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
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
      return "Allowed";
    case "allow-session":
      return "Allowed this session";
    case "deny":
      return "Denied";
    case "cancelled":
      return "Cancelled";
  }
}

/**
 * Renders an inline permission request card inside the chat message list.
 *
 * In the pending state it shows the tool name, an input preview, and split
 * Allow / Allow in session / Deny controls. Once resolved it collapses to a
 * single line showing the tool name and an outcome badge.
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
    const variant = badgeVariantFor(decision);
    return (
      <div className="flex items-center gap-2 border-l-2 border-border/30 pl-3 py-1 text-xs text-muted-foreground/70">
        <Icon size={13} className="shrink-0 text-muted-foreground/50" />
        <span className="font-medium">{label}</span>
        <Badge variant={variant} size="sm" className="ml-1">
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
      <div className="flex items-center gap-2">
        {/* Split Allow button */}
        <div className="inline-flex rounded-lg overflow-hidden">
          {/* Primary: Allow once */}
          <Button
            variant="default"
            size="xs"
            disabled={responding}
            onClick={() => respond("allow")}
            className="rounded-r-none border-r border-primary-foreground/20"
          >
            <Check size={11} className="mr-1" />
            Allow
          </Button>

          {/* Chevron dropdown: Allow in session */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={responding}
              aria-label="More allow options"
              className="inline-flex h-6 items-center justify-center rounded-l-none rounded-r-[min(var(--radius-md),10px)] border border-transparent bg-primary px-1 text-primary-foreground transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 active:translate-y-px"
            >
              <ChevronDown size={11} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={4}>
              <DropdownMenuItem
                disabled={responding}
                onSelect={() => respond("allow-session")}
              >
                <Check size={11} className="opacity-75" />
                Allow in session
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Deny */}
        <Button
          variant="destructive"
          size="xs"
          disabled={responding}
          onClick={() => respond("deny")}
        >
          <X size={11} className="mr-1" />
          Deny
        </Button>
      </div>
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
