import { beforeEach, describe, expect, it, vi } from "vitest";

const activeTransport = {
  getPullRequestCapabilities: vi.fn(),
  listPullRequests: vi.fn(),
  getPullRequestResource: vi.fn(),
  getPullRequestTimeline: vi.fn(),
  getPullRequestFiles: vi.fn(),
  getPullRequestPatch: vi.fn(),
  cancelPullRequestOperation: vi.fn(),
};

vi.mock("../index", () => ({
  getTransport: () => activeTransport,
}));

import { getPullRequestTransport } from "../pull-requests";

describe("pull request transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards named RPC calls without per-row fan-out", async () => {
    activeTransport.getPullRequestCapabilities.mockResolvedValue({ ok: false });
    activeTransport.listPullRequests.mockResolvedValue({ ok: false });
    activeTransport.getPullRequestResource.mockResolvedValue({ ok: false });
    activeTransport.getPullRequestTimeline.mockResolvedValue({ ok: false });
    activeTransport.getPullRequestFiles.mockResolvedValue({ ok: false });
    activeTransport.getPullRequestPatch.mockResolvedValue({ ok: false });
    activeTransport.cancelPullRequestOperation.mockResolvedValue({
      ok: true,
      cancelled: true,
    });
    const transport = getPullRequestTransport();
    const listRequest = {
      operationId: "list-1",
      provider: "github" as const,
      relationships: ["authored" as const],
      states: ["open" as const],
      limit: 30,
    };

    await transport.getCapabilities({ operationId: "cap-1", provider: "github" });
    await transport.list(listRequest);
    const identity = {
      provider: "github" as const,
      repositoryNodeId: "R_repo",
      owner: "Mzeey-Empire",
      repository: "mcode",
      number: 10,
    };
    await transport.get({ operationId: "detail-1", resource: "detail", identity });
    await transport.timeline({ operationId: "timeline-1", lane: "initial", identity, limit: 30 });
    await transport.files({
      operationId: "files-1",
      identity,
      baseOid: "a".repeat(40),
      headOid: "b".repeat(40),
      search: "transport",
      changeTypes: ["modified"],
      limit: 100,
    });
    await transport.patch({
      operationId: "patch-1",
      identity,
      baseOid: "a".repeat(40),
      headOid: "b".repeat(40),
      locator: "file_1",
    });
    await transport.cancel({ operationId: "list-1" });

    expect(activeTransport.getPullRequestCapabilities).toHaveBeenCalledWith({
      operationId: "cap-1",
      provider: "github",
    });
    expect(activeTransport.listPullRequests).toHaveBeenCalledOnce();
    expect(activeTransport.listPullRequests).toHaveBeenCalledWith(listRequest);
    expect(activeTransport.getPullRequestResource).toHaveBeenCalledWith({
      operationId: "detail-1",
      resource: "detail",
      identity,
    });
    expect(activeTransport.getPullRequestTimeline).toHaveBeenCalledWith({
      operationId: "timeline-1",
      lane: "initial",
      identity,
      limit: 30,
    });
    expect(activeTransport.getPullRequestFiles).toHaveBeenCalledWith({
      operationId: "files-1",
      identity,
      baseOid: "a".repeat(40),
      headOid: "b".repeat(40),
      search: "transport",
      changeTypes: ["modified"],
      limit: 100,
    });
    expect(activeTransport.getPullRequestPatch).toHaveBeenCalledWith({
      operationId: "patch-1",
      identity,
      baseOid: "a".repeat(40),
      headOid: "b".repeat(40),
      locator: "file_1",
    });
    expect(activeTransport.cancelPullRequestOperation).toHaveBeenCalledWith({
      operationId: "list-1",
    });
  });
});
