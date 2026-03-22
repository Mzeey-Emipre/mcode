import { useEffect, useState } from "react";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = (): boolean => typeof window.__TAURI_INTERNALS__ !== "undefined";

export function App() {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    if (isTauri()) {
      import("@tauri-apps/api/core").then(({ invoke }) => {
        invoke<string>("get_version").then(setVersion);
      });
    }
  }, []);

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">Mcode</h1>
        <p className="mt-2 text-muted-foreground">
          AI Agent Orchestration
        </p>
        {version && (
          <p className="mt-1 text-sm text-muted-foreground">v{version}</p>
        )}
      </div>
    </div>
  );
}
