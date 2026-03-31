import { useCallback } from "react";
import { X, AlertCircle, Info } from "lucide-react";
import { useToastStore, type Toast as ToastData } from "@/stores/toastStore";
import { Button } from "@/components/ui/button";

/** Icon and accent color per toast level. */
const LEVEL_CONFIG = {
  error: {
    icon: AlertCircle,
    accent: "text-destructive",
    ring: "ring-destructive/25",
    bg: "bg-destructive/8",
  },
  info: {
    icon: Info,
    accent: "text-primary",
    ring: "ring-primary/20",
    bg: "bg-primary/8",
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
      role="alert"
      className={[
        "group pointer-events-auto flex w-80 items-start gap-2.5 rounded-lg px-3 py-2.5",
        "bg-popover/95 shadow-lg shadow-black/20 ring-1 backdrop-blur-md",
        config.ring,
        // entrance animation
        "animate-in fade-in-0 slide-in-from-right-4 duration-200",
      ].join(" ")}
    >
      {/* Accent icon */}
      <div className={`mt-0.5 shrink-0 ${config.accent}`}>
        <Icon size={16} strokeWidth={2.25} />
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
        className="shrink-0 mt-0.5 h-5 w-5 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
        aria-label="Dismiss"
      >
        <X size={12} />
      </Button>
    </div>
  );
}

/** Toast container. Renders all active toasts in the top-right corner. */
export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-50 flex flex-col items-end gap-2 p-4"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
