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
    expect(names).toContain("m:plan");
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
    await act(async () => { result.current.onInputChange("/m:pla"); });
    await act(async () => {});

    const planCmd = result.current.items.find((i) => i.name === "m:plan");
    expect(planCmd).toBeDefined();

    await act(async () => {
      result.current.onSelect(planCmd!, (_v: string) => {});
    });
    expect(onMcodeCommand).toHaveBeenCalledWith("toggle-plan");
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

  it("hides /m:plan for copilot provider", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, providerId: "copilot" })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const names = result.current.allCommands.map((c) => c.name);
    expect(names).not.toContain("m:plan");
    expect(names).toContain("compact");
  });

  it("shows /m:plan for claude provider", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, providerId: "claude" })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const names = result.current.allCommands.map((c) => c.name);
    expect(names).toContain("m:plan");
  });

  it("shows /m:plan when no provider is specified", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const names = result.current.allCommands.map((c) => c.name);
    expect(names).toContain("m:plan");
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

  it("shows /goal only for the claude provider (gradual rollout)", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, providerId: "claude" })
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
  it("hides /goal for non-claude providers", async () => {
    const ref = makeAnchor();
    const { result } = renderHook(() =>
      useSlashCommand({ anchorRef: ref, providerId: "codex" })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});
    expect(result.current.allCommands.map((c) => c.name)).not.toContain("goal");
  });

  it("hides /goal when no provider is specified", async () => {
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

  it("self-heals to 'ready' after a skills.changed push lands mid-load (no manual retry)", async () => {
    // Reproduces the stuck-popup symptom at the hook seam: the popup opens,
    // a skills.changed push invalidates the store while the first load is in
    // flight, and the popup must return to the full list on its own. Before
    // the invalidate() isLoading reset, the eager-prefetch effect dead-locked
    // and the popup stayed on built-ins until the user clicked Refresh.
    vi.mocked(getTransport).mockReturnValue({
      listSkills: vi.fn().mockResolvedValue([{ name: "commit", description: "Create a git commit" }]),
    } as never);

    const ref = makeAnchor();
    const { result } = renderHook(() => useSlashCommand({ anchorRef: ref }));

    await act(async () => { result.current.onInputChange("/"); });
    // Fire the push concurrently with the in-flight load.
    await act(async () => {
      useSkillsStore.getState().invalidate();
    });
    await act(async () => {});
    await act(async () => {});

    expect(result.current.state.kind).toBe("ready");
    if (result.current.state.kind === "ready") {
      const names = result.current.state.items.map((i) => i.name);
      expect(names).toContain("commit");
    }
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
});
