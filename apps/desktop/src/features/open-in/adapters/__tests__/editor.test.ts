import { describe, expect, it } from "vitest";
import { createEditorAdapter } from "../editor";

describe("createEditorAdapter", () => {
  it("exposes editor-kind metadata from its config", () => {
    const adapter = createEditorAdapter({
      id: "vs",
      label: "Visual Studio",
      iconKey: "visualstudio",
    }, "linux");

    expect(adapter.id).toBe("vs");
    expect(adapter.label).toBe("Visual Studio");
    expect(adapter.kind).toBe("editor");
    expect(adapter.iconKey).toBe("visualstudio");
  });
});
