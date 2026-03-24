import { useState, useEffect, useRef } from "react";
import {
  ChevronDown,
  ChevronRight,
  Lock,
  Sparkles,
  Terminal,
  MousePointer,
  Code,
  Diamond,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MODEL_PROVIDERS,
  findModelById,
  findProviderForModel,
  type ModelProvider,
} from "@/lib/model-registry";
const PROVIDER_META: Record<string, { icon: typeof Sparkles; color: string }> = {
  claude: { icon: Sparkles, color: "text-orange-400" },
  codex: { icon: Terminal, color: "text-emerald-400" },
  cursor: { icon: MousePointer, color: "text-blue-400" },
  opencode: { icon: Code, color: "text-violet-400" },
  gemini: { icon: Diamond, color: "text-sky-400" },
};

interface ModelSelectorProps {
  selectedModelId: string;
  onSelect: (modelId: string) => void;
  /** Fully locked: no changes allowed (agent running) */
  locked: boolean;
  /** Provider locked: can switch models within the same provider but not change provider (thread started) */
  providerLocked?: boolean;
}

export function ModelSelector({ selectedModelId, onSelect, locked, providerLocked }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Delayed hover close so user has time to move to submenu
  const setHoveredWithDelay = (providerId: string | null) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (providerId) {
      // Open immediately
      setHoveredProvider(providerId);
    } else {
      // Close with 300ms delay
      hoverTimeoutRef.current = setTimeout(() => {
        setHoveredProvider(null);
      }, 300);
    }
  };

  const model = findModelById(selectedModelId);
  const provider = findProviderForModel(selectedModelId);
  const meta = provider ? PROVIDER_META[provider.id] : undefined;
  const Icon = meta?.icon ?? Sparkles;
  const iconClass = meta?.color ?? "";
  const shortLabel = model ? model.label.replace(`${provider?.name} `, "") : selectedModelId;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setHoveredProvider(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  if (locked) {
    return (
      <span className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground">
        <Icon size={12} className={iconClass} />
        {shortLabel}
        <Lock size={10} className="ml-0.5 opacity-60" />
      </span>
    );
  }

  const handleSelectModel = (modelId: string) => {
    onSelect(modelId);
    setOpen(false);
    setHoveredProvider(null);
  };

  const renderSubmenu = (p: ModelProvider) => (
    <div
      className="absolute left-full top-0 -ml-1 pl-2 min-w-[160px]"
      onMouseEnter={() => setHoveredWithDelay(p.id)}
      onMouseLeave={() => setHoveredWithDelay(null)}
    >
      <div className="rounded-md border border-border bg-popover p-1 shadow-lg">
      {p.models.map((m) => (
        <button
          key={m.id}
          onClick={() => handleSelectModel(m.id)}
          className={cn(
            "flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs",
            m.id === selectedModelId
              ? "bg-accent text-foreground"
              : "text-popover-foreground hover:bg-accent/50 hover:text-foreground"
          )}
        >
          {m.label}
        </button>
      ))}
      </div>
    </div>
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Icon size={12} className={iconClass} />
        {shortLabel}
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-lg">
          {/* When provider is locked, show only that provider's models directly */}
          {providerLocked && provider ? (
            provider.models.map((m) => (
              <button
                key={m.id}
                onClick={() => handleSelectModel(m.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs",
                  m.id === selectedModelId
                    ? "bg-accent text-foreground"
                    : "text-popover-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                {m.label}
              </button>
            ))
          ) : MODEL_PROVIDERS.map((p) => {
            const pm = PROVIDER_META[p.id];
            const ProvIcon = pm?.icon ?? Sparkles;
            const provIconClass = pm?.color ?? "";
            const hasModels = p.models.length > 0;

            return (
              <div
                key={p.id}
                className="relative"
                onMouseEnter={() => !p.comingSoon && hasModels && setHoveredWithDelay(p.id)}
                onMouseLeave={() => setHoveredWithDelay(null)}
              >
                <button
                  disabled={p.comingSoon}
                  onClick={() => {
                    if (hasModels && p.models.length === 1) {
                      handleSelectModel(p.models[0].id);
                    }
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs",
                    p.comingSoon
                      ? "cursor-default text-muted-foreground/50"
                      : "text-popover-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                >
                  <ProvIcon size={12} className={p.comingSoon ? "opacity-40" : provIconClass} />
                  <span className="flex-1 text-left">{p.name}</span>
                  {p.comingSoon && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                      SOON
                    </span>
                  )}
                  {!p.comingSoon && hasModels && p.models.length > 1 && (
                    <ChevronRight size={10} className="text-muted-foreground" />
                  )}
                </button>
                {hoveredProvider === p.id && hasModels && p.models.length > 1 && renderSubmenu(p)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
