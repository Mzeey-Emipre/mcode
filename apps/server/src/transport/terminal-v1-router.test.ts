import { describe, expect, it, vi } from "vitest";
import { getDefaultSettings, TerminalRpcResponseSchema } from "@mcode/contracts";
import { ZodError } from "zod";
import { TerminalBackendError } from "../terminal/terminal-backend.js";
import { routeMessage, type RouterDeps } from "./ws-router.js";

const sessionId = "00000000-0000-4000-8000-000000000001";

function customProfile(index: number, oversized = false) {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    id: `custom:00000000-0000-4000-8000-${suffix}`,
    name: oversized ? "x".repeat(64) : `Shell ${index}`,
    executable: oversized ? "x".repeat(1_024) : "sh",
    arguments: oversized ? Array.from({ length: 16 }, () => "x".repeat(1_024)) : [],
  };
}

describe("Terminal v1 RPC routing", () => {
  it("serializes typed failures in the frozen top-level error envelope", async () => {
    const deps = {
      terminalService: {
        routeV1: async () => {
          throw new TerminalBackendError("HOST_UNHEALTHY", "SAFE_RETRY", "Host is unhealthy", "corr-1");
        },
      },
    } as unknown as RouterDeps;
    const response = await routeMessage(JSON.stringify({
      id: sessionId,
      method: "terminal.session.hasChildren",
      params: { sessionId },
    }), deps, { client: {} as never });

    expect(response).toEqual({
      id: sessionId,
      error: {
        code: "HOST_UNHEALTHY",
        message: "Host is unhealthy",
        retry: "SAFE_RETRY",
        correlationId: "corr-1",
      },
    });
    expect(TerminalRpcResponseSchema("terminal.session.hasChildren").parse(response)).toEqual(response);
  });

  it("routes profile listing and workspace Automatic overrides through typed services", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000002";
    const recovery = {
      status: "blocked" as const,
      reason: "missing-profile-reference" as const,
      blockedProfiles: [{
        id: "custom:00000000-0000-4000-8000-000000000006" as const,
        name: "Recovered shell",
        executable: "sh",
        arguments: [],
      }],
      unavailableProfileId: "custom:00000000-0000-4000-8000-000000000007" as const,
    };
    const terminalProfileService = {
      list: vi.fn().mockResolvedValue({ certified: [], custom: [], recovery }),
      create: vi.fn().mockResolvedValue({
        id: "custom:00000000-0000-4000-8000-000000000005",
        name: "Shell",
        executable: "sh",
        arguments: [],
      }),
      setWorkspaceDefault: vi.fn().mockResolvedValue("automatic"),
    };
    const workspacePreferences = { get: vi.fn() };
    const listResponse = await routeMessage(JSON.stringify({
      id: sessionId,
      method: "terminal.profile.list",
      params: {},
    }), { terminalProfileService } as unknown as RouterDeps);
    const updateResponse = await routeMessage(JSON.stringify({
      id: workspaceId,
      method: "terminal.workspacePreferences.update",
      params: { workspaceId, defaultProfileId: "automatic" },
    }), { terminalProfileService, workspaceTerminalPreferencesService: workspacePreferences } as unknown as RouterDeps);

    expect(listResponse).toEqual({ id: sessionId, result: { certified: [], custom: [], recovery } });
    expect(TerminalRpcResponseSchema("terminal.profile.list").parse(listResponse)).toEqual(listResponse);
    expect(updateResponse).toEqual({
      id: workspaceId,
      result: { workspaceId, defaultProfileId: "automatic" },
    });
    expect(terminalProfileService.list).toHaveBeenCalledOnce();
    const createResponse = await routeMessage(JSON.stringify({
      id: sessionId,
      method: "terminal.profile.create",
      params: { name: "Shell", executable: "sh", arguments: [] },
    }), { terminalProfileService } as unknown as RouterDeps);
    expect(createResponse).toEqual({
      id: sessionId,
      result: { id: "custom:00000000-0000-4000-8000-000000000005", name: "Shell", executable: "sh", arguments: [] },
    });
    expect(terminalProfileService.create).toHaveBeenCalledWith({ name: "Shell", executable: "sh", arguments: [] });
    expect(terminalProfileService.setWorkspaceDefault).toHaveBeenCalledWith(workspaceId, "automatic");
  });

  it("accepts the maximum valid custom catalog when it remains within the RPC budget", async () => {
    const custom = Array.from({ length: 32 }, (_, index) => customProfile(index));
    const response = await routeMessage(JSON.stringify({
      id: sessionId,
      method: "terminal.profile.list",
      params: {},
    }), {
      terminalProfileService: {
        list: vi.fn().mockResolvedValue({ certified: [], custom }),
      },
    } as unknown as RouterDeps);

    expect(TerminalRpcResponseSchema("terminal.profile.list").parse(response)).toEqual(response);
    expect(response).toEqual({ id: sessionId, result: { certified: [], custom } });
  });

  it("fails closed with a typed protocol error for an oversized profile catalog", async () => {
    const custom = Array.from({ length: 32 }, (_, index) => customProfile(index, true));
    const response = await routeMessage(JSON.stringify({
      id: sessionId,
      method: "terminal.profile.list",
      params: {},
    }), {
      terminalProfileService: {
        list: vi.fn().mockResolvedValue({ certified: [], custom }),
      },
    } as unknown as RouterDeps);

    expect(response).toMatchObject({
      id: sessionId,
      error: { code: "PROTOCOL_MISMATCH", retry: "RESTART" },
    });
    expect(TerminalRpcResponseSchema("terminal.profile.list").parse(response)).toEqual(response);
  });

  it("routes preference updates and reset with the workspace override", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000003";
    const settingsService = {
      updateTerminalPreferences: vi.fn().mockReturnValue(getDefaultSettings().terminal),
      resetTerminalPreferences: vi.fn().mockReturnValue(getDefaultSettings().terminal),
    };
    const terminalProfileService = { resetWorkspaceDefault: vi.fn() };
    const workspaceTerminalPreferencesService = { get: vi.fn().mockReturnValue(null) };
    const updateResponse = await routeMessage(JSON.stringify({
      id: sessionId,
      method: "terminal.preferences.update",
      params: { presentation: { fontSize: "lg" } },
    }), { settingsService } as unknown as RouterDeps);
    const resetResponse = await routeMessage(JSON.stringify({
      id: workspaceId,
      method: "terminal.preferences.reset",
      params: { workspaceId },
    }), { settingsService, terminalProfileService, workspaceTerminalPreferencesService } as unknown as RouterDeps);

    expect(updateResponse).toEqual({
      id: sessionId,
      result: {
        terminal: {
          presentation: getDefaultSettings().terminal.presentation,
          behavior: getDefaultSettings().terminal.behavior,
          accessibility: getDefaultSettings().terminal.accessibility,
        },
      },
    });
    expect(resetResponse).toEqual({ id: workspaceId, result: { reset: true } });
    expect(settingsService.updateTerminalPreferences).toHaveBeenCalledWith({ presentation: { fontSize: "lg" } });
    expect(settingsService.resetTerminalPreferences).toHaveBeenCalledOnce();
    expect(terminalProfileService.resetWorkspaceDefault).toHaveBeenCalledWith(workspaceId);
  });

  it("preserves profile-in-use references in the typed error response", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000004";
    const terminalProfileService = {
      delete: vi.fn().mockRejectedValue(Object.assign(new Error("Terminal profile is still used"), {
        code: "PROFILE_IN_USE",
        references: { globalDefault: true, workspaceIds: [workspaceId] },
      })),
    };
    const response = await routeMessage(JSON.stringify({
      id: sessionId,
      method: "terminal.profile.delete",
      params: { profileId: "custom:00000000-0000-4000-8000-000000000006" },
    }), { terminalProfileService } as unknown as RouterDeps);

    expect(response).toMatchObject({
      id: sessionId,
      error: {
        code: "PROFILE_IN_USE",
        retry: "NEW_SESSION",
        data: { references: { globalDefault: true, workspaceIds: [workspaceId] } },
      },
    });
    expect(TerminalRpcResponseSchema("terminal.profile.delete").parse(response)).toEqual(response);
  });

  it("maps service validation failures to SETTINGS_INVALID", async () => {
    const terminalProfileService = {
      create: vi.fn().mockRejectedValue(new ZodError([
        { code: "custom", path: ["name"], message: "invalid name" },
      ])),
    };
    const response = await routeMessage(JSON.stringify({
      id: sessionId,
      method: "terminal.profile.create",
      params: { name: "Shell", executable: "sh", arguments: [] },
    }), { terminalProfileService } as unknown as RouterDeps);

    expect(response).toMatchObject({
      id: sessionId,
      error: { code: "SETTINGS_INVALID", retry: "NEW_SESSION" },
    });
  });
});
