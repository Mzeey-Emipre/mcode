/** Whether the current platform is macOS (used for modifier key display). */
export const isMac: boolean =
  ((navigator as unknown as { userAgentData?: { platform: string } })
    .userAgentData?.platform ?? navigator.platform)
    .toUpperCase()
    .includes("MAC");
