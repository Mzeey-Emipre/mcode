import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock transport so IPC doesn't run
vi.mock("@/transport", () => ({
  getTransport: vi.fn(() => ({
    getProviderCatalog: vi.fn().mockResolvedValue({
      providerId: "claude",
      context: { scope: "user" },
      freshness: { status: "fresh", fetchedAt: "2026-07-20T12:00:00.000Z" },
      diagnostics: [],
      entries: [
        { kind: "skill", identity: { providerId: "claude", kind: "skill", nativeId: "commit" }, name: "commit", description: "Create a git commit", source: "user" },
        { kind: "skill", identity: { providerId: "claude", kind: "skill", nativeId: "review-pr" }, name: "review-pr", description: "Review a pull request", source: "user" },
        { kind: "skill", identity: { providerId: "claude", kind: "skill", nativeId: "tdd" }, name: "tdd", description: "Write tests first", source: "user" },
      ],
      selectableAgents: [],
    }),
  })),
}));

import { useSlashCommand } from "@/components/chat/useSlashCommand";
import { getTransport, type ProviderCatalogRequest } from "@/transport";
import { useProviderCatalogStore } from "@/stores/providerCatalogStore";

interface LegacySkillFixture {
  name: string;
  description: string;
  kind?: "skill" | "command";
  source?: "user" | "project" | "agent" | "plugin";
}

function snapshotFromSkills(
  skills: LegacySkillFixture[],
  request: ProviderCatalogRequest = { providerId: "claude" },
) {
  const context = request.workspaceId
    ? { scope: "workspace" as const, workspaceId: request.workspaceId, ...(request.threadId ? { threadId: request.threadId } : {}) }
    : request.cwd
      ? { scope: "path" as const, cwd: request.cwd }
      : { scope: "user" as const };
  return {
    providerId: request.providerId,
    context,
    freshness: { status: "fresh" as const, fetchedAt: "2026-07-20T12:00:00.000Z" },
    diagnostics: [],
    entries: skills.map((skill) => {
      const kind = skill.kind === "command" ? "providerCommand" as const : "skill" as const;
      const base = {
        kind,
        identity: { providerId: request.providerId, kind, nativeId: skill.name },
        name: skill.name,
        description: skill.description,
      };
      return kind === "skill" ? { ...base, source: skill.source ?? "user" as const } : base;
    }),
    selectableAgents: [],
  };
}

function catalogMock(skills: LegacySkillFixture[]) {
  return vi.fn(async (request: ProviderCatalogRequest) => snapshotFromSkills(skills, request));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset store between tests to prevent cross-test cache pollution now that
  // useSlashCommand delegates caching to the module-scoped provider catalog store.
  useProviderCatalogStore.getState().reset();
});

function makeAnchor() {
  return {
    current: {
      getBoundingClientRect: () => ({
        top: 100, left: 0, bottom: 130, right: 400,
        width: 400, height: 30,
      } as DOMRect),
    },
  } as React.RefObject<HTMLElement>;
}

describe("trigger detection", () => {
  it("opens on '/' at the start", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("/");
    });
    expect(result.current.isOpen).toBe(true);
  });

  it("opens on '/' after whitespace", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("hello /");
    });
    expect(result.current.isOpen).toBe(true);
  });

  it("does NOT open on '/' mid-word", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("abc/def");
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("closes when trigger text is deleted", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("/");
    });
    expect(result.current.isOpen).toBe(true);

    await act(async () => {
      result.current.onInputChange("");
    });
    expect(result.current.isOpen).toBe(false);
  });
});

describe("filter logic", () => {
  it("shows all items on bare '/'", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("/");
    });
    // Wait for async skill load
    await act(async () => {});
    // Should contain mcode commands + loaded skills
    expect(result.current.items.length).toBeGreaterThan(0);
  });

  it("filters case-insensitively by substring", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("/REV");
    });
    await act(async () => {});
    const names = result.current.items.map((i) => i.name);
    expect(names).toContain("review-pr");
    expect(names).not.toContain("commit");
  });

  it("caps rendered command options at 100 and keeps selection in range", async () => {
    const manySkills = Array.from({ length: 150 }, (_, index) => ({
      name: `skill-${String(index).padStart(3, "0")}`,
      description: `Skill ${index}`,
    }));
    vi.mocked(getTransport).mockReturnValue({
      getProviderCatalog: catalogMock(manySkills),
    } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, includeBuiltins: false })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(result.current.items).toHaveLength(100);
    for (let i = 0; i < 120; i++) {
      await act(async () => {
        result.current.onKeyDown({
          key: "ArrowDown",
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent);
      });
    }
    expect(result.current.selectedIndex).toBe(99);

    let inserted = "";
    await act(async () => {
      result.current.onSelect(result.current.items[result.current.selectedIndex], (next) => {
        inserted = next;
      });
    });
    expect(inserted).toBe("/skill-099 ");
  });

  it("matches mcode commands by name without 'm:' prefix in filter", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("/pla");
    });
    await act(async () => {});
    const names = result.current.items.map((i) => i.name);
    expect(names).toContain("plan");
  });
});

describe("keyboard navigation", () => {
  it("ArrowDown increments selectedIndex", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {}); // flush skill load

    expect(result.current.selectedIndex).toBe(0);
    await act(async () => {
      result.current.onKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(result.current.selectedIndex).toBe(1);
  });

  it("ArrowUp decrements selectedIndex", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {}); // flush skill load

    // Move down first so there's room to go up
    await act(async () => {
      result.current.onKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(result.current.selectedIndex).toBe(1);

    await act(async () => {
      result.current.onKeyDown({
        key: "ArrowUp",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(result.current.selectedIndex).toBe(0);
  });

  it("ArrowUp clamps at 0 and does not go negative", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(result.current.selectedIndex).toBe(0);
    await act(async () => {
      result.current.onKeyDown({
        key: "ArrowUp",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(result.current.selectedIndex).toBe(0);
  });

  it("Escape closes the popup", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );
    await act(async () => { result.current.onInputChange("/"); });
    expect(result.current.isOpen).toBe(true);

    await act(async () => {
      result.current.onKeyDown({
        key: "Escape",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent);
    });
    expect(result.current.isOpen).toBe(false);
  });
});

describe("selection + text replacement", () => {
  it("onSelect replaces the trigger text in the input", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );
    await act(async () => { result.current.onInputChange("/com"); });
    await act(async () => {});

    let emittedValue = "";
    await act(async () => {
      result.current.onSelect(
        {
          id: "skill:commit",
          name: "commit",
          description: "Commit changes",
          namespace: "skill",
          capabilityKind: "skill",
          nativeId: "commit",
        },
        (v: string) => { emittedValue = v; }
      );
    });
    expect(emittedValue).toBe("/commit ");
    expect(result.current.isOpen).toBe(false);
  });

  it("inserts focused Mcode guide slash commands", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() => useSlashCommand({ anchorRef: ref }));
    await act(async () => { result.current.onInputChange("/mcode-b"); });
    await act(async () => {});

    const browserCommand = result.current.items.find((item) => item.name === "mcode-browser");
    expect(browserCommand).toBeDefined();
    expect(browserCommand).toMatchObject({
      namespace: "mcode",
      capabilityKind: "mcode",
      id: "builtin:mcode:mcode-browser",
    });

    let inserted = "";
    await act(async () => {
      result.current.onSelect(browserCommand!, (value: string) => { inserted = value; });
    });
    expect(inserted).toBe("/mcode-browser ");

    await act(async () => { result.current.onInputChange("/thread-c"); });
    await act(async () => {});
    const threadCommand = result.current.items.find((item) => item.name === "thread-control");
    expect(threadCommand).toMatchObject({
      namespace: "mcode",
      capabilityKind: "mcode",
      id: "builtin:mcode:thread-control",
    });
    await act(async () => {
      result.current.onSelect(threadCommand!, (value: string) => { inserted = value; });
    });
    expect(inserted).toBe("/thread-control ");

    expect(result.current.allCommands.map((item) => item.name)).not.toContain("mcode-guide");
  });
});

describe("mcode side-effect dispatch", () => {
  it("calls onMcodeCommand with the action when an mcode command is selected", async () => {
    const ref = makeAnchor();
    const onMcodeCommand = vi.fn();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, onMcodeCommand })
    );
    await act(async () => { result.current.onInputChange("/pla"); });
    await act(async () => {});

    const planCmd = result.current.items.find((i) => i.name === "plan");
    expect(planCmd).toBeDefined();

    let emittedValue = "unchanged";
    await act(async () => {
      result.current.onSelect(planCmd!, (value: string) => { emittedValue = value; });
    });
    expect(onMcodeCommand).toHaveBeenCalledWith("attach-plan");
    expect(emittedValue).toBe("");
  });

  it("dispatches Goal as a composer action without inserting slash text", async () => {
    const ref = makeAnchor();
    const onMcodeCommand = vi.fn();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, onMcodeCommand, providerId: "claude" })
    );
    await act(async () => { result.current.onInputChange("/goa"); });
    await act(async () => {});

    const goalCommand = result.current.items.find((item) => item.name === "goal");
    expect(goalCommand).toBeDefined();

    let emittedValue = "unchanged";
    await act(async () => {
      result.current.onSelect(goalCommand!, (value: string) => { emittedValue = value; });
    });
    expect(onMcodeCommand).toHaveBeenCalledWith("attach-goal");
    expect(emittedValue).toBe("");
  });

  it("dispatches Ultra as a composer action without inserting slash text", async () => {
    const ref = makeAnchor();
    const onMcodeCommand = vi.fn();
    const { result } = renderHook(() =>
      useSlashCommand({
        anchorRef: ref,
        onMcodeCommand,
        providerId: "codex",
        modelId: "gpt-5.6-sol",
      })
    );
    await act(async () => { result.current.onInputChange("/ult"); });
    await act(async () => {});

    const ultraCommand = result.current.items.find((item) => item.name === "ultra");
    expect(ultraCommand).toBeDefined();

    let emittedValue = "unchanged";
    await act(async () => {
      result.current.onSelect(ultraCommand!, (value: string) => { emittedValue = value; });
    });
    expect(onMcodeCommand).toHaveBeenCalledWith("attach-orchestration");
    expect(emittedValue).toBe("");
  });

  it("dispatches Ultracode as a composer action without inserting slash text", async () => {
    const ref = makeAnchor();
    const onMcodeCommand = vi.fn();
    const { result } = renderHook(() =>
      useSlashCommand({
        anchorRef: ref,
        onMcodeCommand,
        providerId: "claude",
        modelId: "claude-opus-4-7",
      })
    );
    await act(async () => { result.current.onInputChange("/ultrac"); });
    await act(async () => {});

    const command = result.current.items.find((item) => item.name === "ultracode");
    expect(command).toBeDefined();

    let emittedValue = "unchanged";
    await act(async () => {
      result.current.onSelect(command!, (value: string) => { emittedValue = value; });
    });
    expect(onMcodeCommand).toHaveBeenCalledWith("attach-orchestration");
    expect(emittedValue).toBe("");
  });
});

describe("IPC cache", () => {
  it("eagerly loads and opens the workspace catalog without a thread or cwd", async () => {
    const mockCatalog = catalogMock([{
      name: "workspace-command",
      description: "Workspace command",
    }]);
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog: mockCatalog } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() => useSlashCommand({
      anchorRef: ref,
      providerId: "codex",
      workspaceId: "workspace-1",
      includeBuiltins: false,
    }));

    await act(async () => {});
    expect(mockCatalog).toHaveBeenCalledTimes(1);
    expect(mockCatalog).toHaveBeenCalledWith({
      providerId: "codex",
      workspaceId: "workspace-1",
    });

    await act(async () => {
      result.current.onInputChange("/");
    });
    expect(mockCatalog).toHaveBeenLastCalledWith({
      providerId: "codex",
      workspaceId: "workspace-1",
    });
    expect(result.current.items.map((item) => item.name)).toContain("workspace-command");
  });

  it("calls provider.catalog only once across multiple trigger openings", async () => {
    const mockCatalog = catalogMock([{ name: "commit", description: "Create a git commit" }]);
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog: mockCatalog } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );

    // Open popup twice
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});
    await act(async () => { result.current.onInputChange(""); });
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(mockCatalog).toHaveBeenCalledTimes(1);
  });
});

describe("cwd passthrough", () => {
  it("passes cwd to provider.catalog", async () => {
    const mockCatalog = catalogMock([]);
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog: mockCatalog } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, cwd: "/my/project" })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(mockCatalog).toHaveBeenCalledWith({ providerId: "claude", cwd: "/my/project" });
  });
});

describe("provider-scoped commands", () => {
  it("passes providerId through to store load", async () => {
    const mockCatalog = catalogMock([]);
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog: mockCatalog } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, cwd: "/my/project", providerId: "codex" })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(mockCatalog).toHaveBeenCalledWith({ providerId: "codex", cwd: "/my/project" });
  });

  it("settles two mounted consumers with different provider scopes", async () => {
    const mockCatalog = catalogMock([]);
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog: mockCatalog } as never);
    const composerAnchor = makeAnchor();
    const previewAnchor = makeAnchor();

    renderHook(() => {
      useSlashCommand({
        anchorRef: composerAnchor,
        cwd: "/my/project",
        providerId: "claude",
      });
      useSlashCommand({
        anchorRef: previewAnchor,
        cwd: "/my/project",
        providerId: "codex",
        includeBuiltins: false,
      });
    });
    await act(async () => {});
    await act(async () => {});

    expect(mockCatalog).toHaveBeenCalledTimes(2);
    expect(mockCatalog).toHaveBeenCalledWith({ providerId: "claude", cwd: "/my/project" });
    expect(mockCatalog).toHaveBeenCalledWith({ providerId: "codex", cwd: "/my/project" });
  });

  it("hides /plan for copilot provider", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, providerId: "copilot" })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const names = result.current.allCommands.map((c) => c.name);
    expect(names).not.toContain("plan");
    expect(names).toContain("compact");
  });

  it("shows /plan for claude provider", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, providerId: "claude" })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const names = result.current.allCommands.map((c) => c.name);
    expect(names).toContain("plan");
  });

  it("shows /plan when no provider is specified", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const names = result.current.allCommands.map((c) => c.name);
    expect(names).toContain("plan");
  });

  it("always shows /compact regardless of provider", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, providerId: "copilot" })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const names = result.current.allCommands.map((c) => c.name);
    expect(names).toContain("compact");
  });

  // /goal is a gradual rollout: shown only for providers that support it,
  // hidden for every other provider and when none is selected. The cases are
  // deliberately framed as supported/unsupported, not "Claude vs the rest".
  it.each(["claude", "codex"] as const)("shows /goal for supported provider %s", async (providerId) => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, providerId })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(result.current.allCommands.map((c) => c.name)).toContain("goal");
  });

  // Each provider case is its own test: useSlashCommand subscribes to the
  // module-scoped catalog store, so two hooks mounted at once with different
  // providerIds would fight over the store's cached providerId, each treating
  // the other's value as a provider change and reloading forever (an infinite
  // render loop that OOMs the vitest worker). beforeEach resets the store, so
  // separate tests each get a single hook driving the store.
  it("hides /goal for an unsupported provider", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, providerId: "gemini" })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});
    expect(result.current.allCommands.map((c) => c.name)).not.toContain("goal");
  });

  it("hides /goal when no provider is selected", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() => useSlashCommand({ anchorRef: ref }));
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});
    expect(result.current.allCommands.map((c) => c.name)).not.toContain("goal");
  });
});

describe("popup state machine", () => {
  it("emits a 'ready' state carrying the full command list once skills load", async () => {
    // Self-contained mock: earlier tests leave a mockReturnValue in place
    // (vi.clearAllMocks does not reset return values), so set ours explicitly.
    vi.mocked(getTransport).mockReturnValue({
      getProviderCatalog: catalogMock([{ name: "commit", description: "Create a git commit" }]),
    } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() => useSlashCommand({ anchorRef: ref }));

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(result.current.state.kind).toBe("ready");
    if (result.current.state.kind === "ready") {
      const names = result.current.state.items.map((i) => i.name);
      expect(names).toContain("commit");
    }
  });

  it("is 'closed' before any trigger", () => {
    const ref = makeAnchor();
    const { result } = renderHook(() => useSlashCommand({ anchorRef: ref }));
    expect(result.current.state.kind).toBe("closed");
  });

  it("keeps an open command list stable until the picker closes", async () => {
    const getProviderCatalog = catalogMock([
      { name: "commit", description: "Create a git commit" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() => useSlashCommand({ anchorRef: ref }));

    await act(async () => {});
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {
      useProviderCatalogStore.getState().invalidate();
    });
    await act(async () => {});

    expect(result.current.state.kind).toBe("ready");
    if (result.current.state.kind === "ready") {
      const names = result.current.state.items.map((i) => i.name);
      expect(names).toContain("commit");
    }
    expect(getProviderCatalog).toHaveBeenCalledTimes(1);

    await act(async () => { result.current.onDismiss(); });
    await act(async () => {});

    expect(getProviderCatalog).toHaveBeenCalledTimes(2);
  });

  it("refreshes a warm Codex catalog when the slash picker opens", async () => {
    const getProviderCatalog = catalogMock([
      { name: "prompts:release", description: "Prepare a release", kind: "command" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() => useSlashCommand({
      anchorRef: ref,
      providerId: "codex",
    }));

    await act(async () => {});
    expect(getProviderCatalog).toHaveBeenCalledTimes(1);

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(getProviderCatalog).toHaveBeenCalledTimes(2);
    expect(result.current.items.map((item) => item.name)).toContain("prompts:release");
  });

  it("reconciles changed rows while the Codex picker remains open", async () => {
    const request = { providerId: "codex" as const };
    const getProviderCatalog = vi.fn()
      .mockResolvedValueOnce(snapshotFromSkills([
        { name: "prompts:release", description: "Release v1", kind: "command" },
        { name: "review", description: "Review", kind: "skill" },
      ], request))
      .mockResolvedValueOnce(snapshotFromSkills([
        { name: "prompts:release", description: "Release v2", kind: "command" },
        { name: "review", description: "Review", kind: "skill" },
      ], request));
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog } as never);
    const ref = makeAnchor();
    const { result } = renderHook(() => useSlashCommand({
      anchorRef: ref,
      providerId: "codex",
    }));

    await act(async () => {});
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(result.current.isOpen).toBe(true);
    expect(result.current.items.find((item) => item.name === "prompts:release")?.description)
      .toBe("Release v2");
    expect(result.current.items.map((item) => item.name)).toContain("review");
  });

  it("groups prompt additions and removals while the Codex picker remains open", async () => {
    const request = { providerId: "codex" as const };
    const getProviderCatalog = vi.fn()
      .mockResolvedValueOnce(snapshotFromSkills([
        { name: "prompts:old", description: "Old prompt", kind: "command" },
        { name: "review", description: "Review", kind: "skill" },
      ], request))
      .mockResolvedValueOnce(snapshotFromSkills([
        { name: "prompts:added", description: "Added prompt", kind: "command" },
        { name: "review", description: "Review", kind: "skill" },
      ], request));
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog } as never);
    const ref = makeAnchor();
    const { result } = renderHook(() => useSlashCommand({
      anchorRef: ref,
      providerId: "codex",
      includeBuiltins: false,
    }));

    await act(async () => {});
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(result.current.isOpen).toBe(true);
    expect(result.current.items.map((item) => [item.name, item.namespace])).toEqual([
      ["prompts:added", "command"],
      ["review", "skill"],
    ]);
  });

  it("keeps same-name Skills and custom prompts distinct by catalog identity", async () => {
    const getProviderCatalog = vi.fn().mockResolvedValue({
      providerId: "codex",
      context: { scope: "user" },
      freshness: { status: "fresh", fetchedAt: "2026-07-20T12:00:00.000Z" },
      diagnostics: [],
      entries: [
        {
          kind: "skill",
          identity: { providerId: "codex", kind: "skill", nativeId: "C:/skills/release/SKILL.md" },
          name: "prompts:release",
          description: "Release Skill",
          source: "user",
        },
        {
          kind: "customPrompt",
          identity: { providerId: "codex", kind: "customPrompt", nativeId: "release" },
          name: "prompts:release",
          description: "Release prompt",
        },
      ],
      selectableAgents: [],
    });
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog } as never);
    const ref = makeAnchor();
    const { result } = renderHook(() => useSlashCommand({
      anchorRef: ref,
      providerId: "codex",
    }));

    await act(async () => { result.current.onInputChange("/prompts:release"); });
    await act(async () => {});

    const collisions = result.current.items.filter((item) => item.name === "prompts:release");
    expect(collisions.map((item) => item.identity?.kind)).toEqual([
      "customPrompt",
      "skill",
    ]);
  });
});

describe("includeBuiltins: false", () => {
  it("keeps same-named plugin and Skill entries distinct in the picker", async () => {
    const getProviderCatalog = vi.fn().mockResolvedValue({
      providerId: "codex",
      context: { scope: "user" },
      freshness: { status: "fresh", fetchedAt: "2026-07-20T12:00:00.000Z" },
      diagnostics: [],
      entries: [
        { kind: "providerCommand", identity: { providerId: "codex", kind: "providerCommand", nativeId: "deploy" }, name: "deploy", description: "Deploy" },
        { kind: "customPrompt", identity: { providerId: "codex", kind: "customPrompt", nativeId: "release" }, name: "prompts:release", description: "Release" },
        { kind: "plugin", identity: { providerId: "codex", kind: "plugin", nativeId: "review@personal" }, name: "review", description: "Review plugin", mentionPath: "plugin://review@personal", marketplaceName: "personal", capabilities: [] },
        { kind: "skill", identity: { providerId: "codex", kind: "skill", nativeId: "review" }, name: "review", description: "Review", source: "user" },
      ],
      selectableAgents: [{ providerId: "codex", nativeId: "reviewer", name: "reviewer", path: "C:/agents/reviewer.toml" }],
    });
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog } as never);
    const ref = makeAnchor();
    const { result } = renderHook(() => useSlashCommand({
      anchorRef: ref,
      providerId: "codex",
      includeBuiltins: false,
    }));

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(result.current.allCommands.map((command) => [
      command.name,
      command.namespace,
      command.capabilityKind,
      command.nativeId,
    ])).toEqual([
      ["deploy", "command", "providerCommand", "deploy"],
      ["prompts:release", "command", "customPrompt", "release"],
      ["review", "skill", "skill", "review"],
      ["review", "plugin", "plugin", "review@personal"],
    ]);

    const replaceText = vi.fn();
    await act(async () => {
      result.current.onInputChange("/rev");
      result.current.onSelect(
        result.current.allCommands.find((command) => command.capabilityKind === "plugin")!,
        replaceText,
      );
    });
    expect(replaceText).toHaveBeenCalledWith("@review ");
  });

  it("excludes all BUILTIN_COMMANDS when includeBuiltins is false", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, includeBuiltins: false })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const names = result.current.allCommands.map((c) => c.name);
    // Builtins that MUST be absent
    expect(names).not.toContain("plan");
    expect(names).not.toContain("compact");
    expect(names).not.toContain("goal");
  });

  it("retains skills from the store when includeBuiltins is false", async () => {
    const mockCatalog = catalogMock([
      { name: "commit", description: "Create a git commit" },
      { name: "review-pr", description: "Review a PR" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog: mockCatalog } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, includeBuiltins: false })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const names = result.current.allCommands.map((c) => c.name);
    expect(names).toContain("commit");
    expect(names).toContain("review-pr");
  });

  it("retains plugin-namespaced skills when includeBuiltins is false", async () => {
    const mockCatalog = catalogMock([
      { name: "superpowers:pm", description: "Project manager", source: "plugin" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog: mockCatalog } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, includeBuiltins: false })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const cmd = result.current.allCommands.find((c) => c.name === "superpowers:pm");
    expect(cmd).toBeDefined();
    expect(cmd?.namespace).toBe("plugin");
  });

  it("retains kind==='command' user skills when includeBuiltins is false", async () => {
    const mockCatalog = catalogMock([
      { name: "my-custom", description: "My custom command", kind: "command" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog: mockCatalog } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, includeBuiltins: false })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const cmd = result.current.allCommands.find((c) => c.name === "my-custom");
    expect(cmd).toBeDefined();
    // kind==="command" maps to "command" namespace, not "mcode"
    expect(cmd?.namespace).toBe("command");
  });

  it("still shows the popup when includeBuiltins is false but skills exist", async () => {
    const mockCatalog = catalogMock([
      { name: "commit", description: "Create a git commit" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog: mockCatalog } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, includeBuiltins: false })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(result.current.isOpen).toBe(true);
    expect(result.current.state.kind).toBe("ready");
  });

  it("includeBuiltins defaults to true when omitted", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const names = result.current.allCommands.map((c) => c.name);
    // At minimum, compact is always available (all providers)
    expect(names).toContain("compact");
  });
});

describe("plugin namespace detection", () => {
  it("assigns 'plugin' namespace to skills with colon in name", async () => {
    const mockCatalog = catalogMock([
      { name: "superpowers:project-manager", description: "Manage projects" },
      { name: "commit", description: "Create a git commit" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog: mockCatalog } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const pluginCmd = result.current.items.find((i) => i.name === "superpowers:project-manager");
    const skillCmd = result.current.items.find((i) => i.name === "commit");
    expect(pluginCmd?.namespace).toBe("plugin");
    expect(skillCmd?.namespace).toBe("skill");
  });

  it("assigns 'plugin' namespace to native plugin skills without colon in name", async () => {
    const mockCatalog = catalogMock([
      { name: "control-in-app-browser", description: "Control browser", source: "plugin" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ getProviderCatalog: mockCatalog } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, providerId: "codex" })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(result.current.items.find((i) => i.name === "control-in-app-browser")?.namespace).toBe("plugin");
  });
});
