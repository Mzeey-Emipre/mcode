import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { formatDuration } from "../../lib/time";

interface StreamingIndicatorProps {
  startTime?: number;
}

export function StreamingIndicator({ startTime }: StreamingIndicatorProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) return;

    setElapsed(Math.floor((Date.now() - startTime) / 1000));

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
      <Loader2 size={14} className="animate-spin" />
      <span>Working for {formatDuration(elapsed)}</span>
    </div>
  );
}
