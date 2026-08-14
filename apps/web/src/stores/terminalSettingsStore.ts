import { create } from "zustand";
import type {
  TerminalCustomProfile,
  TerminalPreferencesUpdate,
  TerminalProfileReference,
  TerminalProfileRecovery,
  TerminalResolvedProfile,
} from "@mcode/contracts";
import { getTransport } from "@/transport";
import type { TerminalProfileList } from "@/transport/types";
import { useSettingsStore } from "./settingsStore";

/** Workspace override state exposed to the Terminal settings section. */
export interface TerminalWorkspaceOverride {
  readonly workspaceId: string;
  readonly defaultProfileId: TerminalProfileReference | null;
}

/** Zustand state and actions for Terminal profile operations. */
interface TerminalSettingsState {
  certifiedProfiles: readonly TerminalResolvedProfile[];
  customProfiles: readonly TerminalCustomProfile[];
  recovery: TerminalProfileRecovery | null;
  profilesLoaded: boolean;
  profilesLoading: boolean;
  workspaceOverride: TerminalWorkspaceOverride | null;
  workspaceLoading: boolean;
  pending: boolean;
  error: string | null;
  deleteReferences: { readonly globalDefault: boolean; readonly workspaceIds: readonly string[] } | null;
  fetchProfiles: () => Promise<void>;
  fetchWorkspaceOverride: (workspaceId: string) => Promise<void>;
  setGlobalDefault: (profileId: TerminalProfileReference) => Promise<boolean>;
  setWorkspaceDefault: (workspaceId: string, profileId: TerminalProfileReference) => Promise<boolean>;
  resetWorkspaceDefault: (workspaceId: string) => Promise<boolean>;
  createProfile: (input: Omit<TerminalCustomProfile, "id">) => Promise<boolean>;
  updateProfile: (input: Omit<TerminalCustomProfile, "id"> & { profileId: string }) => Promise<boolean>;
  deleteProfile: (profileId: string) => Promise<boolean>;
  updatePreferences: (input: TerminalPreferencesUpdate) => Promise<boolean>;
  resetPreferences: (workspaceId?: string) => Promise<boolean>;
  clearError: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Terminal settings could not be updated.";
}

function deleteErrorReferences(error: unknown): TerminalSettingsState["deleteReferences"] {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const references = (data as { references?: unknown }).references;
  if (!references || typeof references !== "object") return null;
  const value = references as { globalDefault?: unknown; workspaceIds?: unknown };
  if (typeof value.globalDefault !== "boolean" || !Array.isArray(value.workspaceIds)) return null;
  if (!value.workspaceIds.every((workspaceId) => typeof workspaceId === "string")) return null;
  return {
    globalDefault: value.globalDefault,
    workspaceIds: value.workspaceIds,
  };
}

async function loadProfileList(): Promise<TerminalProfileList> {
  return getTransport().terminalProfileList();
}

/** Terminal settings store backed by the typed Terminal v1 management seam. */
export const useTerminalSettingsStore = create<TerminalSettingsState>((set, get) => ({
  certifiedProfiles: [],
  customProfiles: [],
  recovery: null,
  profilesLoaded: false,
  profilesLoading: false,
  workspaceOverride: null,
  workspaceLoading: false,
  pending: false,
  error: null,
  deleteReferences: null,

  fetchProfiles: async () => {
    set({ profilesLoading: true, error: null, deleteReferences: null });
    try {
      const result = await loadProfileList();
      set({
        certifiedProfiles: result.certified,
        customProfiles: result.custom,
        recovery: result.recovery ?? null,
        profilesLoaded: true,
      });
    } catch (error) {
      set({ error: errorMessage(error) });
    } finally {
      set({ profilesLoading: false });
    }
  },

  fetchWorkspaceOverride: async (workspaceId) => {
    set({ workspaceLoading: true, error: null });
    try {
      const result = await getTransport().terminalWorkspacePreferencesGet(workspaceId);
      set({ workspaceOverride: result.defaultProfileId ? result : null });
    } catch (error) {
      set({ workspaceOverride: null, error: errorMessage(error) });
    } finally {
      set({ workspaceLoading: false });
    }
  },

  setGlobalDefault: async (profileId) => {
    set({ pending: true, error: null });
    try {
      await getTransport().terminalProfileSetDefault(profileId);
      await useSettingsStore.getState().fetch();
      return true;
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    } finally {
      set({ pending: false });
    }
  },

  setWorkspaceDefault: async (workspaceId, profileId) => {
    set({ pending: true, error: null });
    try {
      const result = await getTransport().terminalWorkspacePreferencesUpdate(workspaceId, profileId);
      set({ workspaceOverride: result });
      return true;
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    } finally {
      set({ pending: false });
    }
  },

  resetWorkspaceDefault: async (workspaceId) => {
    set({ pending: true, error: null });
    try {
      await getTransport().terminalWorkspacePreferencesReset(workspaceId);
      set({ workspaceOverride: null });
      return true;
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    } finally {
      set({ pending: false });
    }
  },

  createProfile: async (input) => {
    set({ pending: true, error: null, deleteReferences: null });
    try {
      const profile = await getTransport().terminalProfileCreate(input);
      set((state) => ({ customProfiles: [...state.customProfiles, profile] }));
      return true;
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    } finally {
      set({ pending: false });
    }
  },

  updateProfile: async (input) => {
    set({ pending: true, error: null, deleteReferences: null });
    try {
      const profile = await getTransport().terminalProfileUpdate(input);
      set((state) => ({
        customProfiles: state.customProfiles.map((candidate) => candidate.id === profile.id ? profile : candidate),
      }));
      return true;
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    } finally {
      set({ pending: false });
    }
  },

  deleteProfile: async (profileId) => {
    set({ pending: true, error: null, deleteReferences: null });
    try {
      await getTransport().terminalProfileDelete(profileId);
      set((state) => ({ customProfiles: state.customProfiles.filter((profile) => profile.id !== profileId) }));
      return true;
    } catch (error) {
      set({ error: errorMessage(error), deleteReferences: deleteErrorReferences(error) });
      return false;
    } finally {
      set({ pending: false });
    }
  },

  updatePreferences: async (input) => {
    set({ pending: true, error: null });
    try {
      const result = await getTransport().terminalPreferencesUpdate(input);
      useSettingsStore.getState()._applyTerminalPreferences(result.terminal);
      return true;
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    } finally {
      set({ pending: false });
    }
  },

  resetPreferences: async (workspaceId) => {
    set({ pending: true, error: null });
    try {
      await getTransport().terminalPreferencesReset(workspaceId);
      await Promise.all([
        useSettingsStore.getState().fetch(),
        get().fetchProfiles(),
        ...(workspaceId ? [get().fetchWorkspaceOverride(workspaceId)] : []),
      ]);
      return true;
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    } finally {
      set({ pending: false });
    }
  },

  clearError: () => set({ error: null, deleteReferences: null }),
}));
