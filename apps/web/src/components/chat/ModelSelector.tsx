import { useState, useEffect, useRef, useCallback, useMemo, useId, type ComponentType } from "react";
import { ChevronDown, Lock, Check, Loader2, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatContextWindow } from "./format-context-window";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  MODEL_PROVIDERS,
  findModelById,
  isModelAvailable,
  type ModelProvider,
} from "@/lib/model-registry";
import { getTransport } from "@/transport";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import {
  useModelFavoritesStore,
  type ModelFavoriteEntry,
} from "@/stores/modelFavoritesStore";
import { tokenizeSearch, matchesAllTokens } from "@/lib/searchTokens";
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
  cursor: { icon: CursorProviderIcon, color: "" },
  opencode: { icon: OpenCodeIcon, color: "text-violet-400" },
  gemini: { icon: GeminiIcon, color: "text-sky-400" },
};

/** Matches Tailwind `w-[52px]` for header alignment and icon-first rail. */
const LEFT_RAIL_WIDTH_CLASS = "w-[52px]";

/** True when the catalog uses subgroup rows so a provider title above would repeat RPC group labels. */
function catalogUsesModelGroups(models: ModelProvider["models"]): boolean {
  return models.some((m) => Boolean(m.group?.trim()));
}

/** Tooltip copy for the left rail when a row cannot open a catalog. */
function providerRailUnavailableReason(
  p: ModelProvider,
  providerDisabled: boolean,
): string {
  if (p.comingSoon && providerDisabled) {
    return `${p.name} is coming soon and disabled in settings.`;
  }
  if (p.comingSoon) return `${p.name} is coming soon.`;
  if (providerDisabled) {
    return `${p.name} is disabled. Enable it in Settings under Providers.`;
  }
  return `${p.name}`;
}

/** Left rail segment: browse starred models or a single provider's catalog. */
type LeftRailSelection = "favorites" | string;

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
  const [leftRailSelection, setLeftRailSelection] = useState<LeftRailSelection>("favorites");
  const [rightPanelSearch, setRightPanelSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const prevOpenRef = useRef(false);
  const panelId = useId();

  const favorites = useModelFavoritesStore((s) => s.entries);
  const toggleFavorite = useModelFavoritesStore((s) => s.toggleFavorite);
  const isFavorite = useModelFavoritesStore((s) => s.isFavorite);

  const availabilityList = useProviderAvailabilityStore((s) => s.providers);

  const [dynamicModels, setDynamicModels] = useState<Map<string, ModelProvider["models"]>>(new Map());
  const dynamicModelsRef = useRef<Map<string, ModelProvider["models"]>>(new Map());
  const [loadingProviders, setLoadingProviders] = useState<Set<string>>(new Set());
  const fetchingRef = useRef<Set<string>>(new Set());
  /** Timestamps of the last failed fetch per provider, used to enforce a retry cooldown. */
  const fetchFailedAtRef = useRef<Map<string, number>>(new Map());
  /** How long to wait before retrying a provider after a failed fetch. */
  const FETCH_RETRY_COOLDOWN_MS = 30_000;

  /** Fetches live models for a provider and caches the result. No-ops while a fetch is in-flight, the cache is populated, or within the retry cooldown after a failure. */
  const fetchProviderModels = useCallback(async (providerId: string) => {
    const lastFailedAt = fetchFailedAtRef.current.get(providerId);
    if (
      fetchingRef.current.has(providerId) ||
      dynamicModelsRef.current.has(providerId) ||
      (lastFailedAt !== undefined && Date.now() - lastFailedAt < FETCH_RETRY_COOLDOWN_MS)
    ) return;
    fetchingRef.current.add(providerId);
    setLoadingProviders((prev) => new Set(prev).add(providerId));
    try {
      const info = await getTransport().listProviderModels(providerId);
      const mapped: ModelProvider["models"] = info.map((m) => ({
        id: m.id,
        label: m.name,
        providerId,
        group: m.group,
        contextWindow: m.contextWindow,
        multiplier: m.multiplier,
      }));
      const updated = new Map(dynamicModelsRef.current).set(providerId, mapped);
      dynamicModelsRef.current = updated;
      setDynamicModels(updated);
    } catch {
      fetchFailedAtRef.current.set(providerId, Date.now());
    } finally {
      fetchingRef.current.delete(providerId);
      setLoadingProviders((prev) => {
        const next = new Set(prev);
        next.delete(providerId);
        return next;
      });
    }
  }, []);

  const getModels = (p: ModelProvider): ModelProvider["models"] => {
    const dynamic = dynamicModels.get(p.id);
    return dynamic && dynamic.length > 0 ? dynamic : p.models;
  };

  const isProviderUsable = useCallback(
    (id: string) => {
      const r = availabilityList.find((x) => x.id === id);
      if (!r) return true;
      return r.enabled && r.hasAdapter && r.cli.status !== "not_found";
    },
    [availabilityList],
  );

  const filterModelsBySearchQuery = useCallback((models: ModelProvider["models"], q: string) => {
    const tokens = tokenizeSearch(q);
    if (tokens.length === 0) return models;
    return models.filter((m) =>
      matchesAllTokens([m.label, m.id, m.group ?? ""], tokens),
    );
  }, []);

  const model = findModelById(selectedModelId);
  const normalizedSelectedId = model?.id ?? selectedModelId;

  const displayProvider = selectedProviderId
    ? MODEL_PROVIDERS.find((p) => p.id === selectedProviderId)
    : MODEL_PROVIDERS.find((p) => p.models.some((m) => m.id === normalizedSelectedId));

  const meta = displayProvider ? PROVIDER_META[displayProvider.id] : undefined;
  const Icon = meta?.icon ?? ClaudeIcon;
  const iconClass = meta?.color ?? "";
  const shortLabel = model && displayProvider
    ? model.label.replace(`${displayProvider.name} `, "")
    : (model?.label ?? selectedModelId);

  const defaultProviderId = useMemo(() => {
    const preferred = selectedProviderId ?? displayProvider?.id;
    if (preferred && MODEL_PROVIDERS.some((p) => p.id === preferred)) return preferred;
    return MODEL_PROVIDERS.find((p) => !p.comingSoon)?.id ?? "favorites";
  }, [selectedProviderId, displayProvider?.id]);

  const providersForLeftRail = useMemo(() => {
    if (providerLocked && displayProvider) {
      return MODEL_PROVIDERS.filter((p) => p.id === displayProvider.id);
    }
    return MODEL_PROVIDERS;
  }, [providerLocked, displayProvider]);

  const favoritesVisible = useMemo(() => {
    return favorites.filter((f) => {
      if (!isProviderUsable(f.providerId)) return false;
      if (providerLocked && displayProvider && f.providerId !== displayProvider.id) return false;
      return true;
    });
  }, [favorites, isProviderUsable, providerLocked, displayProvider]);

  const favoritesFiltered = useMemo(() => {
    const tokens = tokenizeSearch(rightPanelSearch);
    if (tokens.length === 0) return favoritesVisible;
    return favoritesVisible.filter((f) =>
      matchesAllTokens([f.label, f.modelId], tokens),
    );
  }, [favoritesVisible, rightPanelSearch]);

  /** When the menu opens, reset rail + search so the right pane matches the current thread provider. */
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      if (providerLocked && displayProvider) {
        setLeftRailSelection(displayProvider.id);
      } else {
        setLeftRailSelection(defaultProviderId);
      }
      setRightPanelSearch("");
    }
    prevOpenRef.current = open;
  }, [open, providerLocked, displayProvider?.id, defaultProviderId]);

  useEffect(() => {
    if (!open || locked) return;
    if (leftRailSelection !== "favorites") {
      void fetchProviderModels(leftRailSelection);
      return;
    }
    const ids = new Set<string>();
    for (const f of favoritesVisible) {
      ids.add(f.providerId);
    }
    for (const id of ids) void fetchProviderModels(id);
  }, [open, locked, leftRailSelection, favoritesVisible, fetchProviderModels]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (locked) {
    return (
      <span className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
        <Icon size={12} className={iconClass} aria-hidden />
        <span>{shortLabel}</span>
        <Lock size={10} className="ml-0.5 opacity-75" aria-hidden />
      </span>
    );
  }

  const handleSelectModel = (modelId: string, providerId: string) => {
    onSelect(modelId, providerId);
    setOpen(false);
  };

  const selectLeftRail = (key: LeftRailSelection) => {
    setLeftRailSelection(key);
    setRightPanelSearch("");
  };

  const searchAriaLabel =
    leftRailSelection === "favorites"
      ? "Filter favorites by name. Use multiple words to narrow results."
      : "Filter models by name or id. Use multiple words to narrow results.";

  const renderFavoriteRow = (entry: ModelFavoriteEntry) => {
    const pm = PROVIDER_META[entry.providerId];
    const ProvIcon = pm?.icon ?? ClaudeIcon;
    const provIconClass = pm?.color ?? "";
    const starred = isFavorite(entry.providerId, entry.modelId);
    const selected =
      entry.modelId === normalizedSelectedId &&
      entry.providerId === (selectedProviderId ?? displayProvider?.id);
    return (
      <div
        key={`${entry.providerId}:${entry.modelId}`}
        className="flex w-full items-center gap-0.5 rounded px-1"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={starred ? `Remove ${entry.label} from favorites` : `Add ${entry.label} to favorites`}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite({
              providerId: entry.providerId,
              modelId: entry.modelId,
              label: entry.label,
            });
          }}
        >
          <Star
            size={12}
            className={cn(starred && "fill-amber-400 text-amber-400")}
            aria-hidden
          />
        </Button>
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          aria-label={
            selected ? `${entry.label}, selected` : `Select ${entry.label}`
          }
          onClick={() => handleSelectModel(entry.modelId, entry.providerId)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-xs",
            selected
              ? "bg-accent text-foreground"
              : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <ProvIcon size={12} className={provIconClass} aria-hidden />
          <span className="truncate text-left">{entry.label}</span>
        </button>
      </div>
    );
  };

  /** Groups a provider's models by their `group` field. Returns ungrouped if none use it. */
  const groupModels = (models: ModelProvider["models"]) => {
    const hasGroups = models.some((m) => m.group?.trim());
    if (!hasGroups) return null;
    const seen = new Map<string, typeof models>();
    for (const m of models) {
      const g = m.group?.trim() ?? "";
      if (!seen.has(g)) seen.set(g, []);
      seen.get(g)!.push(m);
    }
    const result: { label: string; models: typeof models }[] = [];
    seen.forEach((ms, label) => result.push({ label, models: ms }));
    return result;
  };

  const renderModelRow = (
    m: ModelProvider["models"][0],
    providerId: string,
    isSelected: (id: string) => boolean,
  ) => {
    const ctxLabel = formatContextWindow(m.contextWindow);
    const starred = isFavorite(providerId, m.id);
    const selected = isSelected(m.id);
    const available = isModelAvailable(m);
    if (!available) {
      const endDate = new Date(`${m.availableUntil}T00:00:00`).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      return (
        <div key={m.id} className="flex w-full items-center gap-0.5 rounded px-1">
          <span className="h-7 w-7 shrink-0" aria-hidden />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  disabled
                  data-testid={`model-row-gated-${m.id}`}
                  aria-label={`${m.label}, no longer available`}
                  className="flex min-w-0 flex-1 cursor-not-allowed items-center gap-2 rounded px-2 py-1.5 text-xs text-muted-foreground/60"
                >
                  <span className="flex-1 truncate text-left">{m.label}</span>
                  <span className="text-[10px] tabular-nums shrink-0">Ended {endDate}</span>
                </button>
              }
            />
            <TooltipContent side="right">
              Subscription access to {m.label} ended on {endDate}.
            </TooltipContent>
          </Tooltip>
        </div>
      );
    }
    return (
      <div key={m.id} className="flex w-full items-center gap-0.5 rounded px-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={starred ? `Remove ${m.label} from favorites` : `Add ${m.label} to favorites`}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite({ providerId, modelId: m.id, label: m.label });
          }}
        >
          <Star
            size={12}
            className={cn(starred && "fill-amber-400 text-amber-400")}
            aria-hidden
          />
        </Button>
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          aria-label={selected ? `${m.label}, selected` : `Select ${m.label}`}
          onClick={() => handleSelectModel(m.id, providerId)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-xs",
            selected
              ? "bg-accent text-foreground"
              : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <span className="flex-1 truncate text-left">{m.label}</span>
          {ctxLabel && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
              {ctxLabel}
            </span>
          )}
          {m.multiplier != null && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
              {m.multiplier}x
            </span>
          )}
          {m.availableUntil && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
              Until {new Date(`${m.availableUntil}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
            </span>
          )}
          {selected && (
            <Check size={10} className="shrink-0 text-foreground" aria-hidden />
          )}
        </button>
      </div>
    );
  };

  const renderGroupedModels = (
    models: ModelProvider["models"],
    providerId: string,
    isSelected: (id: string) => boolean,
    searchQuery: string,
  ) => {
    const filtered = filterModelsBySearchQuery(models, searchQuery);
    const groups = groupModels(filtered);
    if (!groups) {
      return filtered.map((m) => renderModelRow(m, providerId, isSelected));
    }
    return groups.map(({ label, models: gModels }) => {
      const groupSlug = label.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
      const headingId = `${panelId}-g-${providerId}-${groupSlug}`;
      return (
      <div key={label}>
        <div
          className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 select-none"
          id={headingId}
        >
          {label}
        </div>
        <div aria-labelledby={headingId}>
          {gModels.map((m) => renderModelRow(m, providerId, isSelected))}
        </div>
      </div>
    );
    });
  };

  const panelSearchTestId =
    providerLocked && displayProvider ? "model-selector-locked-search" : "model-selector-panel-search";

  const renderRightPanel = () => {
    if (leftRailSelection === "favorites") {
      if (favoritesFiltered.length === 0) {
        const emptyList = favoritesVisible.length === 0;
        return (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground leading-relaxed">
            {emptyList
              ? "No favorites yet. Open a provider on the left, then star models you use often."
              : "No favorites match your search."}
          </p>
        );
      }
      return (
        <div className="space-y-0.5">
          <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 select-none">
            Favorites
          </div>
          {favoritesFiltered.map((entry) => renderFavoriteRow(entry))}
        </div>
      );
    }

    const p = MODEL_PROVIDERS.find((x) => x.id === leftRailSelection);
    if (!p) return null;

    const isSelected = (modelId: string) =>
      modelId === normalizedSelectedId && p.id === (selectedProviderId ?? displayProvider?.id);

    const loadedModels = getModels(p);
    const showProviderTitle = !catalogUsesModelGroups(loadedModels);

    return (
      <div className="space-y-0.5">
        {loadingProviders.has(p.id) ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={14} className="animate-spin text-muted-foreground" aria-hidden />
            <span className="sr-only">Loading models</span>
          </div>
        ) : (
          <>
            {showProviderTitle && (
              <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 select-none">
                {p.name}
              </div>
            )}
            {renderGroupedModels(loadedModels, p.id, isSelected, rightPanelSearch)}
          </>
        )}
      </div>
    );
  };

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="ghost"
        size="xs"
        data-testid="model-selector-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
      >
        <Icon size={14} className={iconClass} aria-hidden />
        <span className="text-sm">{shortLabel}</span>
        <ChevronDown size={11} aria-hidden />
      </Button>

      {/* Fixed shell height keeps layout stable when switching providers; lists scroll inside. */}
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Choose model and provider"
          className={cn(
            "absolute bottom-full left-0 z-20 mb-1 flex h-[min(440px,calc(100vh-8rem))] w-[min(92vw,520px)] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-lg",
          )}
        >
          <div className="flex shrink-0 border-b border-border/40">
            <div
              className={cn(LEFT_RAIL_WIDTH_CLASS, "shrink-0 border-r border-border/40")}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1 p-1.5">
              <Input
                size="xs"
                placeholder={leftRailSelection === "favorites" ? "Search favorites…" : "Search models…"}
                value={rightPanelSearch}
                onChange={(e) => setRightPanelSearch(e.target.value)}
                data-testid={panelSearchTestId}
                className="h-7"
                aria-label={searchAriaLabel}
              />
            </div>
          </div>

          <div className="flex min-h-0 flex-1 divide-x divide-border/40">
            <nav
              className={cn(
                LEFT_RAIL_WIDTH_CLASS,
                "flex shrink-0 flex-col items-center gap-1 overflow-y-auto bg-muted/15 py-1",
              )}
              aria-label={providerLocked ? "Scope and favorites" : "Favorites and providers"}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      data-testid="model-selector-rail-favorites"
                      onClick={() => selectLeftRail("favorites")}
                      aria-current={leftRailSelection === "favorites" ? "true" : undefined}
                      aria-label="Favorites"
                      className={cn(
                        "flex h-10 w-10 items-center justify-center rounded-md transition-colors",
                        leftRailSelection === "favorites"
                          ? "bg-accent text-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                      )}
                    >
                      <Star
                        size={18}
                        className={cn(leftRailSelection === "favorites" && "fill-amber-400 text-amber-400")}
                        aria-hidden
                      />
                    </button>
                  }
                />
                <TooltipContent side="right">Saved models</TooltipContent>
              </Tooltip>

              <div className="my-0.5 h-px w-8 shrink-0 bg-border/50" aria-hidden />

              {providersForLeftRail.map((p) => {
                const pm = PROVIDER_META[p.id];
                const ProvIcon = pm?.icon ?? ClaudeIcon;
                const provIconClass = pm?.color ?? "";
                const providerRecord = availabilityList.find((x) => x.id === p.id);
                const providerDisabled = providerRecord ? !providerRecord.enabled : false;
                const singleStaticModel = p.models.length === 1;
                const unavailable = p.comingSoon || providerDisabled;
                const tip = unavailable
                  ? providerRailUnavailableReason(p, providerDisabled)
                  : singleStaticModel
                    ? `Select ${p.models[0].label}`
                    : `Browse ${p.name} models`;

                return (
                  <Tooltip key={p.id}>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          data-testid={`model-group-${p.id}`}
                          data-disabled={providerDisabled ? "true" : "false"}
                          disabled={unavailable}
                          aria-current={leftRailSelection === p.id && !singleStaticModel ? "true" : undefined}
                          aria-label={unavailable ? tip : p.name}
                          onClick={() => {
                            if (unavailable) return;
                            if (singleStaticModel) {
                              handleSelectModel(p.models[0].id, p.id);
                              return;
                            }
                            selectLeftRail(p.id);
                          }}
                          className={cn(
                            "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors",
                            unavailable && "cursor-not-allowed opacity-45",
                            !unavailable && "text-popover-foreground hover:bg-accent/40 hover:text-foreground",
                            leftRailSelection === p.id && !singleStaticModel && !unavailable && "bg-accent text-foreground shadow-sm",
                          )}
                        >
                          <ProvIcon size={18} className={p.comingSoon ? "opacity-50" : provIconClass} aria-hidden />
                          {unavailable && (
                            <span
                              className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-muted-foreground/80"
                              aria-hidden
                            />
                          )}
                        </button>
                      }
                    />
                    <TooltipContent side="right">{tip}</TooltipContent>
                  </Tooltip>
                );
              })}
            </nav>

            <div
              className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-popover p-1"
              role="region"
              aria-label="Model list"
            >
              {renderRightPanel()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
