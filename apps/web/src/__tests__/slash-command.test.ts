import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock transport so IPC doesn't run
vi.mock("@/transport", () => ({
  getTransport: vi.fn(() => ({
    listSkills: vi.fn().mockResolvedValue([
      { name: "commit", description: "Create a git commit" },
      { name: "review-pr", description: "Review a pull request" },
      { name: "tdd", description: "Write tests first" },
    ]),
  })),
}));

import { useSlashCommand } from "@/components/chat/useSlashCommand";
import { getTransport } from "@/transport";
import { useSkillsStore } from "@/stores/skillsStore";

beforeEach(() => {
  vi.clearAllMocks();
  // Reset store between tests to prevent cross-test cache pollution now that
  // useSlashCommand delegates caching to the module-scoped skillsStore.
  useSkillsStore.getState().reset();
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
      listSkills: vi.fn().mockResolvedValue(manySkills),
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
        { name: "commit", description: "Commit changes", namespace: "skill" },
        (v: string) => { emittedValue = v; }
      );
    });
    expect(emittedValue).toBe("/commit ");
    expect(result.current.isOpen).toBe(false);
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
});

describe("IPC cache", () => {
  it("calls listSkills only once across multiple trigger openings", async () => {
    const mockListSkills = vi.fn().mockResolvedValue([{ name: "commit", description: "Create a git commit" }]);
    vi.mocked(getTransport).mockReturnValue({ listSkills: mockListSkills } as never);

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

    expect(mockListSkills).toHaveBeenCalledTimes(1);
  });
});

describe("cwd passthrough", () => {
  it("passes cwd to listSkills", async () => {
    const mockListSkills = vi.fn().mockResolvedValue([]);
    vi.mocked(getTransport).mockReturnValue({ listSkills: mockListSkills } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, cwd: "/my/project" })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(mockListSkills).toHaveBeenCalledWith("/my/project", undefined);
  });
});

describe("provider-scoped commands", () => {
  it("passes providerId through to store load", async () => {
    const mockListSkills = vi.fn().mockResolvedValue([]);
    vi.mocked(getTransport).mockReturnValue({ listSkills: mockListSkills } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, cwd: "/my/project", providerId: "codex" })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(mockListSkills).toHaveBeenCalledWith("/my/project", "codex");
  });

  it("settles two mounted consumers with different provider scopes", async () => {
    const mockListSkills = vi.fn().mockResolvedValue([]);
    vi.mocked(getTransport).mockReturnValue({ listSkills: mockListSkills } as never);
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
        providerId: undefined,
        includeBuiltins: false,
      });
    });
    await act(async () => {});
    await act(async () => {});

    expect(mockListSkills).toHaveBeenCalledTimes(2);
    expect(mockListSkills).toHaveBeenCalledWith("/my/project", "claude");
    expect(mockListSkills).toHaveBeenCalledWith("/my/project", undefined);
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
  // module-scoped skillsStore, so two hooks mounted at once with different
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
      listSkills: vi.fn().mockResolvedValue([{ name: "commit", description: "Create a git commit" }]),
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
    const listSkills = vi.fn().mockResolvedValue([
      { name: "commit", description: "Create a git commit" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ listSkills } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() => useSlashCommand({ anchorRef: ref }));

    await act(async () => {});
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {
      useSkillsStore.getState().invalidate();
    });
    await act(async () => {});

    expect(result.current.state.kind).toBe("ready");
    if (result.current.state.kind === "ready") {
      const names = result.current.state.items.map((i) => i.name);
      expect(names).toContain("commit");
    }
    expect(listSkills).toHaveBeenCalledTimes(1);

    await act(async () => { result.current.onDismiss(); });
    await act(async () => {});

    expect(listSkills).toHaveBeenCalledTimes(2);
  });
});

describe("includeBuiltins: false", () => {
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
    const mockListSkills = vi.fn().mockResolvedValue([
      { name: "commit", description: "Create a git commit" },
      { name: "review-pr", description: "Review a PR" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ listSkills: mockListSkills } as never);

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
    const mockListSkills = vi.fn().mockResolvedValue([
      { name: "superpowers:pm", description: "Project manager", source: "plugin" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ listSkills: mockListSkills } as never);

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
    const mockListSkills = vi.fn().mockResolvedValue([
      { name: "my-custom", description: "My custom command", kind: "command" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ listSkills: mockListSkills } as never);

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
    const mockListSkills = vi.fn().mockResolvedValue([
      { name: "commit", description: "Create a git commit" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ listSkills: mockListSkills } as never);

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
    const mockListSkills = vi.fn().mockResolvedValue([
      { name: "superpowers:project-manager", description: "Manage projects" },
      { name: "commit", description: "Create a git commit" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ listSkills: mockListSkills } as never);

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
    const mockListSkills = vi.fn().mockResolvedValue([
      { name: "control-in-app-browser", description: "Control browser", source: "plugin" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ listSkills: mockListSkills } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, providerId: "codex" })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(result.current.items.find((i) => i.name === "control-in-app-browser")?.namespace).toBe("plugin");
  });
});
