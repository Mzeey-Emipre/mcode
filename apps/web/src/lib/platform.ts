const platform = (
  (navigator as unknown as { userAgentData?: { platform: string } })
    .userAgentData?.platform ?? navigator.platform
).toUpperCase();

/** Whether the current platform is macOS (used for modifier key display). */
export const isMac: boolean = platform.includes("MAC");

/** Whether the current platform is Windows. */
export const isWindows: boolean = platform.includes("WIN");
