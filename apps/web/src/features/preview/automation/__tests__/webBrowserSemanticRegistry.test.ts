import { describe, expect, it } from "vitest";
import { WebBrowserSemanticRegistry } from "../webBrowserSemanticRegistry";

describe("WebBrowserSemanticRegistry", () => {
  it("refreshes an evicted connected element identity without resolving stale ids", () => {
    const registry = new WebBrowserSemanticRegistry();
    const first = document.createElement("button");
    document.body.replaceChildren(first);
    const firstId = registry.register(document, first);
    const otherElements = Array.from({ length: 256 }, () => document.createElement("button"));
    document.body.append(...otherElements);
    for (const element of otherElements) registry.register(document, element);

    expect(registry.resolve(document, firstId)).toBeNull();
    const refreshedId = registry.register(document, first);
    expect(registry.resolve(document, refreshedId)).toBe(first);
    document.body.replaceChildren();
  });
});
