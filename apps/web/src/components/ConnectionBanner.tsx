import { useConnectionStore } from "@/stores/connectionStore";
import { Spinner } from "@/components/ui/spinner";

/** Banner shown when the WebSocket connection is lost and reconnecting. */
export function ConnectionBanner() {
  const status = useConnectionStore((s) => s.status);

  if (status !== "reconnecting" && status !== "authFailed") return null;

  return (
    <div className="flex items-center justify-center gap-2 bg-yellow-600/90 px-4 py-1.5 text-xs font-medium text-white">
      <Spinner size={14} className="text-current" />
      {status === "authFailed"
        ? "Re-authenticating after server restart..."
        : "Connection lost. Reconnecting to server..."}
    </div>
  );
}
