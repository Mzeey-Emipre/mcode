import { useCallback } from "react";
import { X, AlertCircle, Info } from "lucide-react";
import { useToastStore, type Toast as ToastData } from "@/stores/toastStore";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Icon, text accent, and chip tint per toast level. */
const LEVEL_CONFIG = {
  error: {
    icon: AlertCircle,
    accent: "text-destructive",
    chip: "bg-destructive/10",
  },
  info: {
    icon: Info,
    accent: "text-primary",
    chip: "bg-primary/10",
  },
} as const;

/** Individual toast notification pill. */
function ToastItem({ toast }: { toast: ToastData }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const handleDismiss = useCallback(() => dismiss(toast.id), [dismiss, toast.id]);

  const config = LEVEL_CONFIG[toast.level];
  const Icon = config.icon;

  return (
    <div
      role={toast.level === "info" ? "status" : "alert"}
      className={cn(
        "group pointer-events-auto flex w-80 items-start gap-2.5 rounded-lg px-3 py-2.5",
        // --popover equals --background in the light theme, so a neutral fill
        // gives no separation on its own. A 1px border plus elevation defines
        // the card; the level color lives in the icon chip, not a colored ring
        // (which previously read as a red box outline against the page).
        "border border-border bg-popover shadow-lg shadow-black/25",
        // entrance animation - toasts rise from below the stack, matching
        // the bottom-right anchor on the container.
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
      )}
    >
      {/* Level icon in a quiet tinted chip so the accent stays localized. */}
      <div
        className={cn(
          "mt-px grid size-7 shrink-0 place-items-center rounded-md",
          config.chip,
          config.accent,
        )}
      >
        <Icon size={15} strokeWidth={2.25} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-foreground leading-snug">{toast.title}</p>
        {toast.message && (
          <p className="mt-0.5 text-xs text-muted-foreground leading-snug line-clamp-2">
            {toast.message}
          </p>
        )}
      </div>

      {/* Dismiss */}
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={handleDismiss}
        className="shrink-0 mt-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
        aria-label="Dismiss"
      >
        <X />
      </Button>
    </div>
  );
}

/**
 * Toast container. Anchored to the bottom-right of the viewport in the
 * page-chrome strip (outside the floating panels) so notifications don't
 * collide with the chat header's icon row (Open / terminal / browser / +).
 * The 1.5 (6px) inset matches the app's outer panel grid padding so the
 * stack reads as part of the same grid system, not a floating overlay.
 * `flex-col-reverse` keeps the newest toast nearest the corner, where the
 * user's attention naturally lands after a composer action.
 */
export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="app-toast-stack pointer-events-none fixed bottom-1.5 right-1.5 z-50 flex flex-col-reverse items-end gap-2 overflow-hidden"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
