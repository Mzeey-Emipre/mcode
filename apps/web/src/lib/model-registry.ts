export interface ModelProvider {
  id: string;
  name: string;
  comingSoon: boolean;
  models: ModelDefinition[];
}

export interface ModelDefinition {
  id: string;
  label: string;
  providerId: string;
}

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  {
    id: "claude",
    name: "Claude",
    comingSoon: false,
    models: [
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", providerId: "claude" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", providerId: "claude" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", providerId: "claude" },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    comingSoon: true,
    models: [],
  },
  {
    id: "cursor",
    name: "Cursor",
    comingSoon: true,
    models: [],
  },
  {
    id: "opencode",
    name: "OpenCode",
    comingSoon: true,
    models: [],
  },
  {
    id: "gemini",
    name: "Gemini",
    comingSoon: true,
    models: [],
  },
];

export function findModelById(id: string): ModelDefinition | undefined {
  for (const p of MODEL_PROVIDERS) {
    const m = p.models.find((model) => model.id === id);
    if (m) return m;
  }
  return undefined;
}

export function findProviderForModel(modelId: string): ModelProvider | undefined {
  return MODEL_PROVIDERS.find((p) => p.models.some((m) => m.id === modelId));
}

export function getDefaultModel(): ModelDefinition {
  return MODEL_PROVIDERS[0].models[1]; // Claude Sonnet 4.6
}
