import { useState, useEffect, useRef, type ComponentType } from "react";
import { ChevronDown, ChevronRight, Lock, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  MODEL_PROVIDERS,
  findModelById,
  type ModelProvider,
} from "@/lib/model-registry";
import {
  ClaudeIcon,
  CodexIcon,
  CursorProviderIcon,
  OpenCodeIcon,
  GeminiIcon,
  CopilotIcon,
} from "./ProviderIcons";

type IconComponent = ComponentType<{ size?: number; className?: string }>;

const PROVIDER_META: Record<string, { icon: IconComponent; color: string }> = {
  claude: { icon: ClaudeIcon, color: "text-orange-500 dark:text-orange-400" },
  codex: { icon: CodexIcon, color: "text-emerald-400" },
  copilot: { icon: CopilotIcon, color: "text-violet-400 dark:text-violet-300" },
  cursor: { icon: CursorProviderIcon, color: "text-blue-400" },
  opencode: { icon: OpenCodeIcon, color: "text-violet-400" },
  gemini: { icon: GeminiIcon, color: "text-sky-400" },
};

interface ModelSelectorProps {
  selectedModelId: string;
  /**
   * Explicit provider ID for the selected model. Required when multiple
   * providers share the same model ID (e.g. "gpt-5.3-codex" exists in both
   * Codex and Copilot). Without this, the selector cannot determine which
   * provider's icon/label to show, and the wrong provider may be committed.
   */
  selectedProviderId?: string;
  /** Called with both the model ID and the provider it was selected from. */
  onSelect: (modelId: string, providerId: string) => void;
  /** Fully locked: no changes allowed (agent running) */
  locked: boolean;
  /** Provider locked: can switch models within the same provider but not change provider (thread started) */
  providerLocked?: boolean;
}

/** Renders a model selection dropdown and controls selection state. */
export function ModelSelector({ selectedModelId, selectedProviderId, onSelect, locked, providerLocked }: ModelSelectorProps) {
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
      setHoveredProvider(providerId);
    } else {
      hoverTimeoutRef.current = setTimeout(() => {
        setHoveredProvider(null);
      }, 300);
    }
  };

  const model = findModelById(selectedModelId);
  const normalizedSelectedId = model?.id ?? selectedModelId;

  // Resolve display provider: prefer the explicit selectedProviderId so that
  // providers sharing the same model ID (e.g. Codex vs Copilot) show correctly.
  const displayProvider = selectedProviderId
    ? MODEL_PROVIDERS.find((p) => p.id === selectedProviderId)
    : MODEL_PROVIDERS.find((p) => p.models.some((m) => m.id === normalizedSelectedId));

  const meta = displayProvider ? PROVIDER_META[displayProvider.id] : undefined;
  const Icon = meta?.icon ?? ClaudeIcon;
  const iconClass = meta?.color ?? "";
  const shortLabel = model ? model.label.replace(`${displayProvider?.name} `, "") : selectedModelId;

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
      <span className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
        <Icon size={12} className={iconClass} />
        {shortLabel}
        <Lock size={10} className="ml-0.5 opacity-75" />
      </span>
    );
  }

  const handleSelectModel = (modelId: string, providerId: string) => {
    onSelect(modelId, providerId);
    setOpen(false);
    setHoveredProvider(null);
  };

  const renderSubmenu = (p: ModelProvider) => {
    // Group models by their `group` field for providers that use it (e.g. Copilot)
    const hasGroups = p.models.some((m) => m.group);
    const groups: { label: string; models: typeof p.models }[] = [];
    if (hasGroups) {
      const seen = new Map<string, typeof p.models>();
      for (const m of p.models) {
        const g = m.group ?? "";
        if (!seen.has(g)) seen.set(g, []);
        seen.get(g)!.push(m);
      }
      seen.forEach((models, label) => groups.push({ label, models }));
    }

    // A model row is "selected" only when both ID and provider match.
    const isSelected = (modelId: string) =>
      modelId === normalizedSelectedId && p.id === (selectedProviderId ?? displayProvider?.id);

    return (
      <div
        className="absolute left-full top-0 -ml-1 pl-2 min-w-[160px]"
        onMouseEnter={() => setHoveredWithDelay(p.id)}
        onMouseLeave={() => setHoveredWithDelay(null)}
      >
        <div className="max-h-[280px] overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg">
          {hasGroups
            ? groups.map(({ label, models }) => (
                <div key={label}>
                  <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 select-none">
                    {label}
                  </div>
                  {models.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => handleSelectModel(m.id, p.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs",
                        isSelected(m.id)
                          ? "bg-accent text-foreground"
                          : "text-popover-foreground hover:bg-accent/50 hover:text-foreground"
                      )}
                    >
                      <span className="flex-1 text-left">{m.label}</span>
                      {m.multiplier != null && m.multiplier !== 1 && (
                        <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                          {m.multiplier}x
                        </span>
                      )}
                      {isSelected(m.id) && (
                        <Check size={10} className="shrink-0 text-foreground" />
                      )}
                    </button>
                  ))}
                </div>
              ))
            : p.models.map((m) => (
                <button
                  key={m.id}
                  onClick={() => handleSelectModel(m.id, p.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs",
                    isSelected(m.id)
                      ? "bg-accent text-foreground"
                      : "text-popover-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                >
                  <span className="flex-1 text-left">{m.label}</span>
                  {m.multiplier != null && m.multiplier !== 1 && (
                    <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                      {m.multiplier}x
                    </span>
                  )}
                  {isSelected(m.id) && (
                    <Check size={10} className="shrink-0 text-foreground" />
                  )}
                </button>
              ))}
        </div>
      </div>
    );
  };

  return (
    <div ref={containerRef} className="relative">
      <Button variant="ghost" size="xs" onClick={() => setOpen(!open)} className="text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors">
        <Icon size={14} className={iconClass} />
        <span className="text-sm">{shortLabel}</span>
        <ChevronDown size={11} />
      </Button>

      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-lg">
          {/* When provider is locked, show only that provider's models directly */}
          {providerLocked && displayProvider ? (
            <div className="max-h-[280px] overflow-y-auto">
              {displayProvider.models.map((m) => (
                <button
                  key={m.id}
                  onClick={() => handleSelectModel(m.id, displayProvider.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs",
                    m.id === normalizedSelectedId
                      ? "bg-accent text-foreground"
                      : "text-popover-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                >
                  <span className="flex-1 text-left">{m.label}</span>
                  {m.multiplier != null && m.multiplier !== 1 && (
                    <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                      {m.multiplier}x
                    </span>
                  )}
                  {m.id === normalizedSelectedId && (
                    <Check size={10} className="shrink-0 text-foreground" />
                  )}
                </button>
              ))}
            </div>
          ) : MODEL_PROVIDERS.map((p) => {
            const pm = PROVIDER_META[p.id];
            const ProvIcon = pm?.icon ?? ClaudeIcon;
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
                      handleSelectModel(p.models[0].id, p.id);
                    }
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs",
                    p.comingSoon
                      ? "cursor-default text-muted-foreground/70"
                      : "text-popover-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                >
                  <ProvIcon size={12} className={p.comingSoon ? "opacity-40" : provIconClass} />
                  <span className="flex-1 text-left">{p.name}</span>
                  {p.comingSoon && (
                    <Badge variant="secondary" size="sm">SOON</Badge>
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
