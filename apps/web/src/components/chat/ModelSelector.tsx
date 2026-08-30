import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useId,
  type ComponentType,
  type ReactNode,
} from "react";
import { ChevronDown, Lock, Check, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatContextWindow } from "./format-context-window";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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
type ModelDefinition = ModelProvider["models"][number];

const DEFAULT_PROVIDER_META = { icon: ClaudeIcon, color: "" };

const PROVIDER_META: Record<string, { icon: IconComponent; color: string }> = {
  claude: { icon: ClaudeIcon, color: "" },
  codex: { icon: CodexIcon, color: "text-foreground" },
  copilot: { icon: CopilotIcon, color: "text-violet-400 dark:text-violet-300" },
  cursor: { icon: CursorProviderIcon, color: "" },
  opencode: { icon: OpenCodeIcon, color: "text-violet-400" },
  gemini: { icon: GeminiIcon, color: "text-sky-400" },
};

/** Matches Tailwind `w-[52px]` for header alignment and icon-first rail. */
const LEFT_RAIL_WIDTH_CLASS = "w-[52px]";

/** How long to wait before retrying a provider after a failed fetch. */
const FETCH_RETRY_COOLDOWN_MS = 30_000;

/** True when the catalog uses subgroup rows so a provider title above would repeat RPC group labels. */
function catalogUsesModelGroups(models: ModelProvider["models"]): boolean {
  return models.some((model) => Boolean(model.group?.trim()));
}

/** Tooltip copy for the left rail when a row cannot open a catalog. */
function providerRailUnavailableReason(
  provider: ModelProvider,
  providerDisabled: boolean,
): string {
  if (provider.comingSoon && providerDisabled) {
    return `${provider.name} is coming soon and disabled in settings.`;
  }
  if (provider.comingSoon) return `${provider.name} is coming soon.`;
  if (providerDisabled) {
    return `${provider.name} is disabled. Enable it in Settings under Providers.`;
  }
  return provider.name;
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

interface SelectedModelPresentation {
  displayProvider?: ModelProvider;
  normalizedModelId: string;
  selectedProviderId?: string;
  icon: IconComponent;
  iconClass: string;
  shortLabel: string;
}

interface ProviderModelCatalog {
  getModels: (provider: ModelProvider) => ModelProvider["models"];
  loadingProviders: Set<string>;
  fetchProviderModels: (providerId: string) => Promise<void>;
}

interface ModelSelectionState {
  selectedModelId: string;
  selectedProviderId?: string;
  onSelect: (modelId: string, providerId: string) => void;
}

interface ModelSelectionProps extends ModelSelectionState {
  modelId: string;
  providerId: string;
}

interface FavoriteToggleProps {
  providerId: string;
  modelId: string;
  label: string;
  starred: boolean;
  onToggle: (entry: ModelFavoriteEntry) => void;
}

interface FavoriteModelRowProps extends ModelSelectionState {
  entry: ModelFavoriteEntry;
  isFavorite: (providerId: string, modelId: string) => boolean;
  onToggleFavorite: (entry: ModelFavoriteEntry) => void;
}

interface ModelRowProps extends ModelSelectionState {
  model: ModelDefinition;
  providerId: string;
  isFavorite: (providerId: string, modelId: string) => boolean;
  onToggleFavorite: (entry: ModelFavoriteEntry) => void;
}

interface GroupedModelListProps extends Omit<ModelRowProps, "model"> {
  models: ModelProvider["models"];
  panelId: string;
  searchQuery: string;
}

interface ModelGroupProps extends Omit<GroupedModelListProps, "models" | "searchQuery"> {
  label: string;
  models: ModelProvider["models"];
}

interface FavoritesPanelProps {
  favoritesVisible: readonly ModelFavoriteEntry[];
  favoritesFiltered: readonly ModelFavoriteEntry[];
  selectedModelId: string;
  selectedProviderId?: string;
  isFavorite: (providerId: string, modelId: string) => boolean;
  onSelect: (modelId: string, providerId: string) => void;
  onToggleFavorite: (entry: ModelFavoriteEntry) => void;
}

interface ProviderModelsPanelProps extends Omit<GroupedModelListProps, "models" | "searchQuery"> {
  provider: ModelProvider;
  searchQuery: string;
  loading: boolean;
  getModels: (provider: ModelProvider) => ModelProvider["models"];
}

interface ModelSelectorRightPanelProps extends Omit<FavoritesPanelProps, "favoritesVisible" | "favoritesFiltered"> {
  leftRailSelection: LeftRailSelection;
  favoritesVisible: readonly ModelFavoriteEntry[];
  favoritesFiltered: readonly ModelFavoriteEntry[];
  loadingProviders: Set<string>;
  getModels: (provider: ModelProvider) => ModelProvider["models"];
  panelId: string;
  searchQuery: string;
}

interface ProviderRailItemProps {
  provider: ModelProvider;
  providerDisabled: boolean;
  selected: boolean;
  onClick: (provider: ModelProvider) => void;
}

interface ProviderRailProps {
  providers: readonly ModelProvider[];
  leftRailSelection: LeftRailSelection;
  providerLocked: boolean | undefined;
  getProviderDisabled: (providerId: string) => boolean;
  onSelectFavorites: () => void;
  onSelectProvider: (provider: ModelProvider) => void;
}

interface ModelSelectorPanelProps extends ModelSelectorRightPanelProps {
  open: boolean;
  providerLocked: boolean | undefined;
  leftRailSelection: LeftRailSelection;
  rightPanelSearch: string;
  providersForLeftRail: readonly ModelProvider[];
  panelSearchTestId: string;
  searchAriaLabel: string;
  onSearchChange: (value: string) => void;
  getProviderDisabled: (providerId: string) => boolean;
  onSelectFavorites: () => void;
  onSelectProvider: (provider: ModelProvider) => void;
}

function getProviderMeta(providerId: string | undefined): {
  icon: IconComponent;
  color: string;
} {
  return PROVIDER_META[providerId ?? ""] ?? DEFAULT_PROVIDER_META;
}

function findDisplayProvider(
  selectedProviderId: string | undefined,
  normalizedModelId: string,
): ModelProvider | undefined {
  if (selectedProviderId) {
    return MODEL_PROVIDERS.find((provider) => provider.id === selectedProviderId);
  }
  return MODEL_PROVIDERS.find((provider) =>
    provider.models.some((model) => model.id === normalizedModelId),
  );
}

function getSelectedModelPresentation(
  selectedModelId: string,
  selectedProviderId: string | undefined,
): SelectedModelPresentation {
  const model = findModelById(selectedModelId);
  const normalizedModelId = model?.id ?? selectedModelId;
  const displayProvider = findDisplayProvider(selectedProviderId, normalizedModelId);
  const providerMeta = getProviderMeta(displayProvider?.id);
  const label = model?.label ?? selectedModelId;
  const shortLabel = model && displayProvider
    ? label.replace(`${displayProvider.name} `, "")
    : label;

  return {
    displayProvider,
    normalizedModelId,
    selectedProviderId: selectedProviderId ?? displayProvider?.id,
    icon: providerMeta.icon,
    iconClass: providerMeta.color,
    shortLabel,
  };
}

function getDefaultProviderId(
  selectedProviderId: string | undefined,
  displayProvider: ModelProvider | undefined,
): LeftRailSelection {
  const preferredProviderId = selectedProviderId ?? displayProvider?.id;
  const providerExists = preferredProviderId
    ? MODEL_PROVIDERS.some((provider) => provider.id === preferredProviderId)
    : false;

  if (providerExists) return preferredProviderId!;
  return MODEL_PROVIDERS.find((provider) => !provider.comingSoon)?.id ?? "favorites";
}

function getProvidersForLeftRail(
  providerLocked: boolean | undefined,
  displayProvider: ModelProvider | undefined,
): readonly ModelProvider[] {
  if (providerLocked && displayProvider) {
    return MODEL_PROVIDERS.filter((provider) => provider.id === displayProvider.id);
  }
  return MODEL_PROVIDERS;
}

function isProviderUsable(
  providerId: string,
  availabilityList: readonly {
    id: string;
    enabled: boolean;
    hasAdapter: boolean;
    cli: { status: string };
  }[],
): boolean {
  const provider = availabilityList.find((entry) => entry.id === providerId);
  if (!provider) return true;
  return provider.enabled && provider.hasAdapter && provider.cli.status !== "not_found";
}

function getVisibleFavorites(
  favorites: readonly ModelFavoriteEntry[],
  canUseProvider: (providerId: string) => boolean,
  providerLocked: boolean | undefined,
  displayProvider: ModelProvider | undefined,
): ModelFavoriteEntry[] {
  return favorites.filter((favorite) => {
    const providerIsHidden = !canUseProvider(favorite.providerId);
    const outsideLockedProvider = providerLocked
      && displayProvider
      && favorite.providerId !== displayProvider.id;
    return !providerIsHidden && !outsideLockedProvider;
  });
}

function filterModelsBySearchQuery(
  models: ModelProvider["models"],
  searchQuery: string,
): ModelProvider["models"] {
  const tokens = tokenizeSearch(searchQuery);
  if (tokens.length === 0) return models;
  return models.filter((model) =>
    matchesAllTokens([model.label, model.id, model.group ?? ""], tokens),
  );
}

function filterFavoritesBySearchQuery(
  favorites: readonly ModelFavoriteEntry[],
  searchQuery: string,
): ModelFavoriteEntry[] {
  const tokens = tokenizeSearch(searchQuery);
  if (tokens.length === 0) return [...favorites];
  return favorites.filter((favorite) =>
    matchesAllTokens([favorite.label, favorite.modelId], tokens),
  );
}

function groupModels(models: ModelProvider["models"]): { label: string; models: ModelProvider["models"] }[] | null {
  if (!catalogUsesModelGroups(models)) return null;

  const groups = new Map<string, ModelProvider["models"]>();
  for (const model of models) {
    const label = model.group?.trim() ?? "";
    const groupedModels = groups.get(label) ?? [];
    groups.set(label, [...groupedModels, model]);
  }
  return [...groups].map(([label, groupedModels]) => ({
    label,
    models: groupedModels,
  }));
}

function isSelectedModel({
  modelId,
  providerId,
  selectedModelId,
  selectedProviderId,
}: ModelSelectionProps): boolean {
  return modelId === selectedModelId && providerId === selectedProviderId;
}

function getSelectedModelAriaLabel(label: string, selected: boolean): string {
  return selected ? `${label}, selected` : `Select ${label}`;
}

function getSelectedModelClassName(selected: boolean): string {
  return selected
    ? "bg-accent text-foreground"
    : "text-popover-foreground hover:bg-accent/50 hover:text-foreground";
}

function getFavoriteActionLabel(label: string, starred: boolean): string {
  return starred ? `Remove ${label} from favorites` : `Add ${label} to favorites`;
}

function getProviderDisabled(
  providerId: string,
  availabilityList: readonly { id: string; enabled: boolean }[],
): boolean {
  const provider = availabilityList.find((entry) => entry.id === providerId);
  return provider ? !provider.enabled : false;
}

function isProviderRailUnavailable(
  provider: ModelProvider,
  providerDisabled: boolean,
): boolean {
  return provider.comingSoon || providerDisabled;
}

function getProviderRailTooltip(
  provider: ModelProvider,
  providerDisabled: boolean,
): string {
  if (isProviderRailUnavailable(provider, providerDisabled)) {
    return providerRailUnavailableReason(provider, providerDisabled);
  }
  if (provider.models.length === 1) return `Select ${provider.models[0].label}`;
  return `Browse ${provider.name} models`;
}

function getProviderRailIconClass(comingSoon: boolean, color: string): string {
  return comingSoon ? "opacity-50" : color;
}

function getSearchAriaLabel(leftRailSelection: LeftRailSelection): string {
  return leftRailSelection === "favorites"
    ? "Filter favorites by name. Use multiple words to narrow results."
    : "Filter models by name or id. Use multiple words to narrow results.";
}

function getPanelSearchTestId(
  providerLocked: boolean | undefined,
  displayProvider: ModelProvider | undefined,
): string {
  return providerLocked && displayProvider
    ? "model-selector-locked-search"
    : "model-selector-panel-search";
}

function getSearchPlaceholder(leftRailSelection: LeftRailSelection): string {
  return leftRailSelection === "favorites" ? "Search favorites…" : "Search models…";
}

function useProviderModelCatalog(): ProviderModelCatalog {
  const [dynamicModels, setDynamicModels] = useState<Map<string, ModelProvider["models"]>>(
    new Map(),
  );
  const dynamicModelsRef = useRef<Map<string, ModelProvider["models"]>>(new Map());
  const [loadingProviders, setLoadingProviders] = useState<Set<string>>(new Set());
  const fetchingRef = useRef<Set<string>>(new Set());
  const fetchFailedAtRef = useRef<Map<string, number>>(new Map());

  const fetchProviderModels = useCallback(async (providerId: string) => {
    const lastFailedAt = fetchFailedAtRef.current.get(providerId);
    const isCoolingDown = lastFailedAt !== undefined
      && Date.now() - lastFailedAt < FETCH_RETRY_COOLDOWN_MS;

    if (
      fetchingRef.current.has(providerId)
      || dynamicModelsRef.current.has(providerId)
      || isCoolingDown
    ) {
      return;
    }

    fetchingRef.current.add(providerId);
    setLoadingProviders((currentProviders) => new Set(currentProviders).add(providerId));
    try {
      const providerModels = await getTransport().listProviderModels(providerId);
      const models: ModelProvider["models"] = providerModels.map((model) => ({
        id: model.id,
        label: model.name,
        providerId,
        group: model.group,
        contextWindow: model.contextWindow,
        multiplier: model.multiplier,
      }));
      const updatedModels = new Map(dynamicModelsRef.current).set(providerId, models);
      dynamicModelsRef.current = updatedModels;
      setDynamicModels(updatedModels);
    } catch {
      fetchFailedAtRef.current.set(providerId, Date.now());
    } finally {
      fetchingRef.current.delete(providerId);
      setLoadingProviders((currentProviders) => {
        const nextProviders = new Set(currentProviders);
        nextProviders.delete(providerId);
        return nextProviders;
      });
    }
  }, []);

  const getModels = useCallback((provider: ModelProvider): ModelProvider["models"] => {
    const models = dynamicModels.get(provider.id);
    return models && models.length > 0 ? models : provider.models;
  }, [dynamicModels]);

  return { getModels, loadingProviders, fetchProviderModels };
}

function useResetModelSelectorPanel(
  open: boolean,
  providerLocked: boolean | undefined,
  displayProvider: ModelProvider | undefined,
  defaultProviderId: LeftRailSelection,
  setLeftRailSelection: (selection: LeftRailSelection) => void,
  setRightPanelSearch: (searchQuery: string) => void,
): void {
  const previouslyOpen = useRef(false);

  useEffect(() => {
    const opened = open && !previouslyOpen.current;
    if (opened) {
      const nextSelection = providerLocked && displayProvider
        ? displayProvider.id
        : defaultProviderId;
      setLeftRailSelection(nextSelection);
      setRightPanelSearch("");
    }
    previouslyOpen.current = open;
  }, [open, providerLocked, displayProvider?.id, defaultProviderId, setLeftRailSelection, setRightPanelSearch]);
}

function useFetchProviderModelsWhenOpen(
  open: boolean,
  locked: boolean,
  leftRailSelection: LeftRailSelection,
  favoritesVisible: readonly ModelFavoriteEntry[],
  fetchProviderModels: (providerId: string) => Promise<void>,
): void {
  useEffect(() => {
    if (!open || locked) return;

    if (leftRailSelection !== "favorites") {
      void fetchProviderModels(leftRailSelection);
      return;
    }

    const providerIds = new Set(favoritesVisible.map((favorite) => favorite.providerId));
    for (const providerId of providerIds) {
      void fetchProviderModels(providerId);
    }
  }, [open, locked, leftRailSelection, favoritesVisible, fetchProviderModels]);
}

function useCloseWhenClickOutside(
  containerRef: React.RefObject<HTMLDivElement | null>,
  setOpen: (open: boolean) => void,
): void {
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [containerRef, setOpen]);
}

function FavoriteToggle({
  providerId,
  modelId,
  label,
  starred,
  onToggle,
}: FavoriteToggleProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={getFavoriteActionLabel(label, starred)}
      onClick={(event) => {
        event.stopPropagation();
        onToggle({ providerId, modelId, label });
      }}
    >
      <Star
        size={12}
        className={cn(starred && "fill-amber-400 text-amber-400")}
        aria-hidden
      />
    </Button>
  );
}

function ModelSelectionButton({
  modelId,
  providerId,
  selectedModelId,
  selectedProviderId,
  onSelect,
  label,
  children,
}: ModelSelectionProps & { label: string; children: ReactNode }) {
  const selected = isSelectedModel({
    modelId,
    providerId,
    selectedModelId,
    selectedProviderId,
    onSelect,
  });

  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      aria-label={getSelectedModelAriaLabel(label, selected)}
      onClick={() => onSelect(modelId, providerId)}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-xs",
        getSelectedModelClassName(selected),
      )}
    >
      {children}
    </button>
  );
}

function FavoriteModelRow({
  entry,
  selectedModelId,
  selectedProviderId,
  onSelect,
  isFavorite,
  onToggleFavorite,
}: FavoriteModelRowProps) {
  const providerMeta = getProviderMeta(entry.providerId);
  const ProviderIcon = providerMeta.icon;
  const starred = isFavorite(entry.providerId, entry.modelId);

  return (
    <div
      key={`${entry.providerId}:${entry.modelId}`}
      className="flex w-full items-center gap-0.5 rounded px-1"
    >
      <FavoriteToggle
        providerId={entry.providerId}
        modelId={entry.modelId}
        label={entry.label}
        starred={starred}
        onToggle={onToggleFavorite}
      />
      <ModelSelectionButton
        modelId={entry.modelId}
        providerId={entry.providerId}
        selectedModelId={selectedModelId}
        selectedProviderId={selectedProviderId}
        onSelect={onSelect}
        label={entry.label}
      >
        <ProviderIcon size={12} className={providerMeta.color} aria-hidden />
        <span className="truncate text-left">{entry.label}</span>
      </ModelSelectionButton>
    </div>
  );
}

function GatedModelRow({ model }: { model: ModelDefinition }) {
  const endDate = new Date(`${model.availableUntil}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <div key={model.id} className="flex w-full items-center gap-0.5 rounded px-1">
      <span className="h-7 w-7 shrink-0" aria-hidden />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled
              data-testid={`model-row-gated-${model.id}`}
              aria-label={`${model.label}, no longer available`}
              className="flex min-w-0 flex-1 cursor-not-allowed items-center gap-2 rounded px-2 py-1.5 text-xs text-muted-foreground/60"
            >
              <span className="flex-1 truncate text-left">{model.label}</span>
              <span className="text-xs tabular-nums shrink-0">Ended {endDate}</span>
            </button>
          }
        />
        <TooltipContent side="right">
          Subscription access to {model.label} ended on {endDate}.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function ModelMetadata({ model }: { model: ModelDefinition }) {
  const contextLabel = formatContextWindow(model.contextWindow);
  const availableUntil = model.availableUntil
    ? new Date(`${model.availableUntil}T00:00:00`).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
    })
    : undefined;

  return (
    <>
      {contextLabel && (
        <span className="text-xs text-muted-foreground/60 tabular-nums shrink-0">
          {contextLabel}
        </span>
      )}
      {model.multiplier != null && (
        <span className="text-xs text-muted-foreground/60 tabular-nums shrink-0">
          {model.multiplier}x
        </span>
      )}
      {availableUntil && (
        <span className="text-xs text-muted-foreground/60 tabular-nums shrink-0">
          Until {availableUntil}
        </span>
      )}
    </>
  );
}

function AvailableModelRow({
  model,
  providerId,
  selectedModelId,
  selectedProviderId,
  onSelect,
  isFavorite,
  onToggleFavorite,
}: ModelRowProps) {
  const selected = isSelectedModel({
    modelId: model.id,
    providerId,
    selectedModelId,
    selectedProviderId,
    onSelect,
  });
  const starred = isFavorite(providerId, model.id);

  return (
    <div key={model.id} className="flex w-full items-center gap-0.5 rounded px-1">
      <FavoriteToggle
        providerId={providerId}
        modelId={model.id}
        label={model.label}
        starred={starred}
        onToggle={onToggleFavorite}
      />
      <ModelSelectionButton
        modelId={model.id}
        providerId={providerId}
        selectedModelId={selectedModelId}
        selectedProviderId={selectedProviderId}
        onSelect={onSelect}
        label={model.label}
      >
        <span className="flex-1 truncate text-left">{model.label}</span>
        <ModelMetadata model={model} />
        {selected && <Check size={10} className="shrink-0 text-foreground" aria-hidden />}
      </ModelSelectionButton>
    </div>
  );
}

function ModelRow(props: ModelRowProps) {
  return isModelAvailable(props.model)
    ? <AvailableModelRow {...props} />
    : <GatedModelRow model={props.model} />;
}

function ModelGroup({
  label,
  models,
  panelId,
  providerId,
  selectedModelId,
  selectedProviderId,
  onSelect,
  isFavorite,
  onToggleFavorite,
}: ModelGroupProps) {
  const groupSlug = label.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
  const headingId = `${panelId}-g-${providerId}-${groupSlug}`;

  return (
    <div key={label}>
      <div
        className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground/60 select-none"
        id={headingId}
      >
        {label}
      </div>
      <div aria-labelledby={headingId}>
        {models.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            providerId={providerId}
            selectedModelId={selectedModelId}
            selectedProviderId={selectedProviderId}
            onSelect={onSelect}
            isFavorite={isFavorite}
            onToggleFavorite={onToggleFavorite}
          />
        ))}
      </div>
    </div>
  );
}

function GroupedModelList({
  models,
  providerId,
  selectedModelId,
  selectedProviderId,
  onSelect,
  isFavorite,
  onToggleFavorite,
  panelId,
  searchQuery,
}: GroupedModelListProps) {
  const filteredModels = filterModelsBySearchQuery(models, searchQuery);
  const groups = groupModels(filteredModels);

  if (!groups) {
    return filteredModels.map((model) => (
      <ModelRow
        key={model.id}
        model={model}
        providerId={providerId}
        selectedModelId={selectedModelId}
        selectedProviderId={selectedProviderId}
        onSelect={onSelect}
        isFavorite={isFavorite}
        onToggleFavorite={onToggleFavorite}
      />
    ));
  }

  return groups.map((group) => (
    <ModelGroup
      key={group.label}
      label={group.label}
      models={group.models}
      panelId={panelId}
      providerId={providerId}
      selectedModelId={selectedModelId}
      selectedProviderId={selectedProviderId}
      onSelect={onSelect}
      isFavorite={isFavorite}
      onToggleFavorite={onToggleFavorite}
    />
  ));
}

function EmptyFavoritesMessage({
  hasFavorites,
}: {
  hasFavorites: boolean;
}) {
  const message = hasFavorites
    ? "No favorites match your search."
    : "No favorites yet. Open a provider on the left, then star models you use often.";

  return (
    <p className="px-3 py-8 text-center text-xs text-muted-foreground leading-relaxed">
      {message}
    </p>
  );
}

function FavoritesPanel({
  favoritesVisible,
  favoritesFiltered,
  selectedModelId,
  selectedProviderId,
  isFavorite,
  onSelect,
  onToggleFavorite,
}: FavoritesPanelProps) {
  if (favoritesFiltered.length === 0) {
    return <EmptyFavoritesMessage hasFavorites={favoritesVisible.length > 0} />;
  }

  return (
    <div className="space-y-0.5">
      <div className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground/60 select-none">
        Favorites
      </div>
      {favoritesFiltered.map((entry) => (
        <FavoriteModelRow
          key={`${entry.providerId}:${entry.modelId}`}
          entry={entry}
          selectedModelId={selectedModelId}
          selectedProviderId={selectedProviderId}
          onSelect={onSelect}
          isFavorite={isFavorite}
          onToggleFavorite={onToggleFavorite}
        />
      ))}
    </div>
  );
}

function ProviderCatalogContent({
  loading,
  provider,
  models,
  ...modelListProps
}: Omit<ProviderModelsPanelProps, "getModels"> & {
  models: ModelProvider["models"];
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner size={14} className="text-muted-foreground" />
        <span className="sr-only">Loading models</span>
      </div>
    );
  }

  return (
    <>
      {!catalogUsesModelGroups(models) && (
        <div className="px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground/60 select-none">
          {provider.name}
        </div>
      )}
      <GroupedModelList models={models} {...modelListProps} />
    </>
  );
}

function ProviderModelsPanel({
  provider,
  loading,
  getModels,
  ...modelListProps
}: ProviderModelsPanelProps) {
  const models = getModels(provider);

  return (
    <div className="space-y-0.5">
      <ProviderCatalogContent
        provider={provider}
        loading={loading}
        models={models}
        {...modelListProps}
      />
    </div>
  );
}

function ModelSelectorRightPanel({
  leftRailSelection,
  favoritesVisible,
  favoritesFiltered,
  loadingProviders,
  getModels,
  panelId,
  searchQuery,
  selectedModelId,
  selectedProviderId,
  isFavorite,
  onSelect,
  onToggleFavorite,
}: ModelSelectorRightPanelProps) {
  if (leftRailSelection === "favorites") {
    return (
      <FavoritesPanel
        favoritesVisible={favoritesVisible}
        favoritesFiltered={favoritesFiltered}
        selectedModelId={selectedModelId}
        selectedProviderId={selectedProviderId}
        isFavorite={isFavorite}
        onSelect={onSelect}
        onToggleFavorite={onToggleFavorite}
      />
    );
  }

  const provider = MODEL_PROVIDERS.find((entry) => entry.id === leftRailSelection);
  if (!provider) return null;

  return (
    <ProviderModelsPanel
      provider={provider}
      loading={loadingProviders.has(provider.id)}
      getModels={getModels}
      panelId={panelId}
      searchQuery={searchQuery}
      providerId={provider.id}
      selectedModelId={selectedModelId}
      selectedProviderId={selectedProviderId}
      isFavorite={isFavorite}
      onSelect={onSelect}
      onToggleFavorite={onToggleFavorite}
    />
  );
}

function ProviderUnavailableIndicator({ unavailable }: { unavailable: boolean }) {
  return unavailable
    ? (
      <span
        className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-muted-foreground/80"
        aria-hidden
      />
    )
    : null;
}

function ProviderRailItem({
  provider,
  providerDisabled,
  selected,
  onClick,
}: ProviderRailItemProps) {
  const providerMeta = getProviderMeta(provider.id);
  const ProviderIcon = providerMeta.icon;
  const unavailable = isProviderRailUnavailable(provider, providerDisabled);
  const tooltip = getProviderRailTooltip(provider, providerDisabled);
  const isCurrent = selected && provider.models.length !== 1 && !unavailable;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid={`model-group-${provider.id}`}
            data-disabled={providerDisabled ? "true" : "false"}
            disabled={unavailable}
            aria-current={isCurrent ? "true" : undefined}
            aria-label={unavailable ? tooltip : provider.name}
            onClick={() => onClick(provider)}
            className={cn(
              "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors",
              unavailable && "cursor-not-allowed opacity-45",
              !unavailable && "text-popover-foreground hover:bg-accent/40 hover:text-foreground",
              isCurrent && "bg-accent text-foreground shadow-sm",
            )}
          >
            <ProviderIcon
              size={18}
              className={getProviderRailIconClass(provider.comingSoon, providerMeta.color)}
              aria-hidden
            />
            <ProviderUnavailableIndicator unavailable={unavailable} />
          </button>
        }
      />
      <TooltipContent side="right">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function ProviderRail({
  providers,
  leftRailSelection,
  providerLocked,
  getProviderDisabled,
  onSelectFavorites,
  onSelectProvider,
}: ProviderRailProps) {
  const favoritesSelected = leftRailSelection === "favorites";

  return (
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
              onClick={onSelectFavorites}
              aria-current={favoritesSelected ? "true" : undefined}
              aria-label="Favorites"
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-md transition-colors",
                favoritesSelected
                  ? "bg-accent text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
              )}
            >
              <Star
                size={18}
                className={cn(favoritesSelected && "fill-amber-400 text-amber-400")}
                aria-hidden
              />
            </button>
          }
        />
        <TooltipContent side="right">Saved models</TooltipContent>
      </Tooltip>

      <div className="my-0.5 h-px w-8 shrink-0 bg-border/50" aria-hidden />

      {providers.map((provider) => (
        <ProviderRailItem
          key={provider.id}
          provider={provider}
          providerDisabled={getProviderDisabled(provider.id)}
          selected={leftRailSelection === provider.id}
          onClick={onSelectProvider}
        />
      ))}
    </nav>
  );
}

function ModelSelectorPanel({
  open,
  providerLocked,
  leftRailSelection,
  rightPanelSearch,
  providersForLeftRail,
  panelSearchTestId,
  searchAriaLabel,
  onSearchChange,
  getProviderDisabled,
  onSelectFavorites,
  onSelectProvider,
  ...rightPanelProps
}: ModelSelectorPanelProps) {
  if (!open) return null;

  return (
    <div
      id={rightPanelProps.panelId}
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
            placeholder={getSearchPlaceholder(leftRailSelection)}
            value={rightPanelSearch}
            onChange={(event) => onSearchChange(event.target.value)}
            data-testid={panelSearchTestId}
            className="h-7"
            aria-label={searchAriaLabel}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 divide-x divide-border/40">
        <ProviderRail
          providers={providersForLeftRail}
          leftRailSelection={leftRailSelection}
          providerLocked={providerLocked}
          getProviderDisabled={getProviderDisabled}
          onSelectFavorites={onSelectFavorites}
          onSelectProvider={onSelectProvider}
        />

        <div
          className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-popover p-1"
          role="region"
          aria-label="Model list"
        >
          <ModelSelectorRightPanel
            {...rightPanelProps}
            leftRailSelection={leftRailSelection}
            searchQuery={rightPanelSearch}
          />
        </div>
      </div>
    </div>
  );
}

function LockedModelLabel({
  icon: Icon,
  iconClass,
  shortLabel,
}: Pick<SelectedModelPresentation, "icon" | "iconClass" | "shortLabel">) {
  return (
    <span className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
      <Icon size={12} className={iconClass} aria-hidden />
      <span>{shortLabel}</span>
      <Lock size={10} className="ml-0.5 opacity-75" aria-hidden />
    </span>
  );
}

/** Renders a model selection dropdown and controls selection state. */
export function ModelSelector({
  selectedModelId,
  selectedProviderId,
  onSelect,
  locked,
  providerLocked,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [leftRailSelection, setLeftRailSelection] = useState<LeftRailSelection>("favorites");
  const [rightPanelSearch, setRightPanelSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const favorites = useModelFavoritesStore((store) => store.entries);
  const toggleFavorite = useModelFavoritesStore((store) => store.toggleFavorite);
  const isFavorite = useModelFavoritesStore((store) => store.isFavorite);
  const availabilityList = useProviderAvailabilityStore((store) => store.providers);
  const { getModels, loadingProviders, fetchProviderModels } = useProviderModelCatalog();
  const presentation = getSelectedModelPresentation(selectedModelId, selectedProviderId);

  const canUseProvider = useCallback(
    (providerId: string) => isProviderUsable(providerId, availabilityList),
    [availabilityList],
  );
  const isProviderDisabled = useCallback(
    (providerId: string) => getProviderDisabled(providerId, availabilityList),
    [availabilityList],
  );
  const defaultProviderId = getDefaultProviderId(selectedProviderId, presentation.displayProvider);
  const providersForLeftRail = getProvidersForLeftRail(providerLocked, presentation.displayProvider);
  const favoritesVisible = useMemo(
    () => getVisibleFavorites(favorites, canUseProvider, providerLocked, presentation.displayProvider),
    [favorites, canUseProvider, providerLocked, presentation.displayProvider],
  );
  const favoritesFiltered = useMemo(
    () => filterFavoritesBySearchQuery(favoritesVisible, rightPanelSearch),
    [favoritesVisible, rightPanelSearch],
  );

  useResetModelSelectorPanel(
    open,
    providerLocked,
    presentation.displayProvider,
    defaultProviderId,
    setLeftRailSelection,
    setRightPanelSearch,
  );
  useFetchProviderModelsWhenOpen(
    open,
    locked,
    leftRailSelection,
    favoritesVisible,
    fetchProviderModels,
  );
  useCloseWhenClickOutside(containerRef, setOpen);

  const handleSelectModel = (modelId: string, providerId: string) => {
    onSelect(modelId, providerId);
    setOpen(false);
  };
  const selectLeftRail = (selection: LeftRailSelection) => {
    setLeftRailSelection(selection);
    setRightPanelSearch("");
  };
  const handleProviderRailClick = (provider: ModelProvider) => {
    const providerDisabled = isProviderDisabled(provider.id);
    if (isProviderRailUnavailable(provider, providerDisabled)) return;
    if (provider.models.length === 1) {
      handleSelectModel(provider.models[0].id, provider.id);
      return;
    }
    selectLeftRail(provider.id);
  };

  if (locked) {
    return <LockedModelLabel {...presentation} />;
  }

  const TriggerIcon = presentation.icon;

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
        <TriggerIcon size={14} className={presentation.iconClass} aria-hidden />
        <span className="text-sm">{presentation.shortLabel}</span>
        <ChevronDown size={11} aria-hidden />
      </Button>

      <ModelSelectorPanel
        open={open}
        providerLocked={providerLocked}
        leftRailSelection={leftRailSelection}
        rightPanelSearch={rightPanelSearch}
        providersForLeftRail={providersForLeftRail}
        panelSearchTestId={getPanelSearchTestId(providerLocked, presentation.displayProvider)}
        searchAriaLabel={getSearchAriaLabel(leftRailSelection)}
        onSearchChange={setRightPanelSearch}
        getProviderDisabled={isProviderDisabled}
        onSelectFavorites={() => selectLeftRail("favorites")}
        onSelectProvider={handleProviderRailClick}
        favoritesVisible={favoritesVisible}
        favoritesFiltered={favoritesFiltered}
        loadingProviders={loadingProviders}
        getModels={getModels}
        panelId={panelId}
        searchQuery={rightPanelSearch}
        selectedModelId={presentation.normalizedModelId}
        selectedProviderId={presentation.selectedProviderId}
        isFavorite={isFavorite}
        onSelect={handleSelectModel}
        onToggleFavorite={toggleFavorite}
      />
    </div>
  );
}
