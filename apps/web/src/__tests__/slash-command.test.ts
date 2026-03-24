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

beforeEach(() => {
  vi.clearAllMocks();
});

function makeTextarea(value = "", selectionStart = value.length) {
  return {
    current: {
      value,
      selectionStart,
      getBoundingClientRect: () => ({
        top: 100, left: 0, bottom: 130, right: 400,
        width: 400, height: 30,
      } as DOMRect),
    },
  } as React.RefObject<HTMLTextAreaElement>;
}

describe("trigger detection", () => {
  it("opens on '/' at the start", async () => {
    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("/");
    });
    expect(result.current.isOpen).toBe(true);
  });

  it("opens on '/' after whitespace", async () => {
    const ref = makeTextarea("hello /");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("hello /");
    });
    expect(result.current.isOpen).toBe(true);
  });

  it("does NOT open on '/' mid-word", async () => {
    const ref = makeTextarea("abc/def");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("abc/def");
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("closes when trigger text is deleted", async () => {
    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => {
      result.current.onInputChange("/");
    });
    expect(result.current.isOpen).toBe(true);

    ref.current!.value = "";
    ref.current!.selectionStart = 0;
    await act(async () => {
      result.current.onInputChange("");
    });
    expect(result.current.isOpen).toBe(false);
  });
});

describe("filter logic", () => {
  it("shows all items on bare '/'", async () => {
    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
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
    const ref = makeTextarea("/REV");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
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
    const ref = makeTextarea("/pla");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
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
    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {}); // flush skill load

    expect(result.current.selectedIndex).toBe(0);
    await act(async () => {
      result.current.onKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
    });
    expect(result.current.selectedIndex).toBe(1);
  });

  it("ArrowUp decrements selectedIndex", async () => {
    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {}); // flush skill load

    // Move down first so there's room to go up
    await act(async () => {
      result.current.onKeyDown({
        key: "ArrowDown",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
    });
    expect(result.current.selectedIndex).toBe(1);

    await act(async () => {
      result.current.onKeyDown({
        key: "ArrowUp",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
    });
    expect(result.current.selectedIndex).toBe(0);
  });

  it("ArrowUp clamps at 0 and does not go negative", async () => {
    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(result.current.selectedIndex).toBe(0);
    await act(async () => {
      result.current.onKeyDown({
        key: "ArrowUp",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
    });
    expect(result.current.selectedIndex).toBe(0);
  });

  it("Escape closes the popup", async () => {
    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );
    await act(async () => { result.current.onInputChange("/"); });
    expect(result.current.isOpen).toBe(true);

    await act(async () => {
      result.current.onKeyDown({
        key: "Escape",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
    });
    expect(result.current.isOpen).toBe(false);
  });
});

describe("selection + text replacement", () => {
  it("onSelect replaces the trigger text in the input", async () => {
    const ref = makeTextarea("/com");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
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
    const ref = makeTextarea("/m:pla");
    const onMcodeCommand = vi.fn();
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref, onMcodeCommand })
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

    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
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

    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref, cwd: "/my/project" })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    expect(mockListSkills).toHaveBeenCalledWith("/my/project");
  });
});

describe("plugin namespace detection", () => {
  it("assigns 'plugin' namespace to skills with colon in name", async () => {
    const mockListSkills = vi.fn().mockResolvedValue([
      { name: "superpowers:project-manager", description: "Manage projects" },
      { name: "commit", description: "Create a git commit" },
    ]);
    vi.mocked(getTransport).mockReturnValue({ listSkills: mockListSkills } as never);

    const ref = makeTextarea("/");
    const { result } = renderHook(() =>
      useSlashCommand({ textareaRef: ref })
    );

    await act(async () => { result.current.onInputChange("/"); });
    await act(async () => {});

    const pluginCmd = result.current.items.find((i) => i.name === "superpowers:project-manager");
    const skillCmd = result.current.items.find((i) => i.name === "commit");
    expect(pluginCmd?.namespace).toBe("plugin");
    expect(skillCmd?.namespace).toBe("skill");
  });
});
