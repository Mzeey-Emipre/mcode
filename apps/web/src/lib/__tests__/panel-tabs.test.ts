import { describe, it, expect } from "vitest";
import { Layers, ListChecks } from "lucide-react";
import {
  PANEL_TAB_TYPES,
  creatableTypes,
  shownTabTypes,
  type PanelTabTypeId,
} from "../panel-tabs";

/** Pull just the ids out of a result for terse assertions. */
function ids(types: readonly { id: PanelTabTypeId }[]): PanelTabTypeId[] {
  return types.map((t) => t.id);
}

describe("PANEL_TAB_TYPES catalog", () => {
  it("declares the seven revamp tab types in prototype order", () => {
    expect(ids(PANEL_TAB_TYPES)).toEqual([
      "preview",
      "terminal",
      "files",
      "changes",
      "tasks",
      "subagents",
      "coordination",
    ]);
  });

  it("marks only Files as coming-soon", () => {
    const comingSoon = PANEL_TAB_TYPES.filter((t) => t.comingSoon).map((t) => t.id);
    expect(comingSoon).toEqual(["files"]);
  });

  it("marks coordination tools as thread-only (Review is dual-scope)", () => {
    const threadOnly = PANEL_TAB_TYPES.filter((t) => t.needsThread).map((t) => t.id);
    expect(threadOnly).toEqual(["tasks", "subagents", "coordination"]);
  });

  it("gives every shortcut-enabled type a commandId", () => {
    for (const type of PANEL_TAB_TYPES) {
      if (type.comingSoon) {
        expect(type.commandId).toBeUndefined();
      } else if (type.id !== "subagents" && type.id !== "coordination") {
        expect(type.commandId).toBeTruthy();
      }
    }
  });

  it("gives every type a label and a blurb", () => {
    for (const type of PANEL_TAB_TYPES) {
      expect(type.label.length).toBeGreaterThan(0);
      expect(type.blurb.length).toBeGreaterThan(0);
    }
  });

  it("uses Plan language for the legacy tasks tab id", () => {
    const plan = PANEL_TAB_TYPES.find((type) => type.id === "tasks");
    expect(plan?.label).toBe("Plan");
    expect(plan?.blurb).toBe("Read saved plans");
    expect(plan?.icon).toBe(ListChecks);
  });

  it("uses Layers for the Subagents panel tab", () => {
    const subagents = PANEL_TAB_TYPES.find((type) => type.id === "subagents");
    expect(subagents?.icon).toBe(Layers);
  });
});

describe("shownTabTypes — scope filter", () => {
  it("drops thread-only types when threadless (Review stays, dual-scope)", () => {
    expect(ids(shownTabTypes("threadless", []))).toEqual([
      "preview",
      "terminal",
      "files",
      "changes",
    ]);
  });

  it("keeps every type in a thread", () => {
    expect(ids(shownTabTypes("thread", []))).toEqual([
      "preview",
      "terminal",
      "files",
      "changes",
      "tasks",
      "subagents",
      "coordination",
    ]);
  });
});

describe("shownTabTypes — cardinality filter", () => {
  it("drops singletons already open", () => {
    expect(ids(shownTabTypes("threadless", ["preview"]))).toEqual([
      "terminal",
      "files",
      "changes",
    ]);
  });

  it("keeps Terminal creatable after other singleton tools are open", () => {
    expect(
      ids(shownTabTypes("thread", ["preview", "terminal", "changes", "tasks", "subagents", "coordination"])),
    ).toEqual(["terminal", "files"]);
  });

  it("ignores open ids that the scope filter already removed", () => {
    // "tasks" is thread-only, so it is dropped by the scope filter regardless of
    // whether it appears in openTabs; the result is unchanged.
    expect(ids(shownTabTypes("threadless", ["tasks"]))).toEqual([
      "preview",
      "terminal",
      "files",
      "changes",
    ]);
  });
});

describe("creatableTypes — coming-soon exclusion", () => {
  it("excludes Files from the creatable set when threadless", () => {
    expect(ids(creatableTypes("threadless", []))).toEqual([
      "preview",
      "terminal",
      "changes",
    ]);
  });

  it("excludes Files from the creatable set in a thread", () => {
    expect(ids(creatableTypes("thread", []))).toEqual([
      "preview",
      "terminal",
      "changes",
      "tasks",
      "subagents",
      "coordination",
    ]);
  });

  it("never returns Files regardless of scope or open tabs", () => {
    const scopes = ["threadless", "thread"] as const;
    for (const scope of scopes) {
      expect(ids(creatableTypes(scope, [])).includes("files")).toBe(false);
      expect(ids(creatableTypes(scope, ["preview"])).includes("files")).toBe(false);
    }
  });
});

describe("creatableTypes — combined scope + cardinality", () => {
  it("drops both scope-filtered and already-open types", () => {
    expect(ids(creatableTypes("threadless", ["preview"]))).toEqual([
      "terminal",
      "changes",
    ]);
  });

  it("keeps Terminal creatable when every singleton tool is open", () => {
    expect(
      ids(creatableTypes("thread", ["preview", "terminal", "changes", "tasks", "subagents", "coordination"])),
    ).toEqual(["terminal"]);
  });

  it("is a strict subset of shownTabTypes (only the coming-soon teaser differs)", () => {
    const shown = ids(shownTabTypes("thread", []));
    const creatable = ids(creatableTypes("thread", []));
    const removed = shown.filter((id) => !creatable.includes(id));
    expect(removed).toEqual(["files"]);
  });
});

describe("creatableTypes / shownTabTypes — purity", () => {
  it("does not mutate the openTabs argument", () => {
    const open: PanelTabTypeId[] = ["preview"];
    creatableTypes("thread", open);
    shownTabTypes("thread", open);
    expect(open).toEqual(["preview"]);
  });

  it("returns results in catalog order", () => {
    // Open tabs given out of order must not reorder the result.
    expect(ids(creatableTypes("thread", ["tasks", "preview"]))).toEqual([
      "terminal",
      "changes",
      "subagents",
      "coordination",
    ]);
  });
});
