import { create } from "zustand";
import type { ConnectionStatus } from "@/transport/ws-transport";

interface ConnectionState {
  /** Current WebSocket connection status. */
  status: ConnectionStatus;
  /** Update the connection status. Called by the transport layer. */
  setStatus: (status: ConnectionStatus) => void;
}

/** Zustand store tracking WebSocket connection health. */
export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "connecting",
  setStatus: (status) => set({ status }),
}));
