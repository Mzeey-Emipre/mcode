import type { TerminalPlatform } from "@mcode/contracts";

/** Maps supported Node host platforms to Terminal protocol platform names. */
export function terminalPlatform(platform: NodeJS.Platform): TerminalPlatform {
  switch (platform) {
    case "win32": return "windows";
    case "darwin": return "macos";
    case "linux": return "linux";
    default: throw new Error(`Unsupported Terminal platform: ${platform}`);
  }
}

/** Maps Terminal protocol platform names back to explicit Node host platforms. */
export function nodePlatformForTerminal(platform: TerminalPlatform): NodeJS.Platform {
  switch (platform) {
    case "windows": return "win32";
    case "macos": return "darwin";
    case "linux": return "linux";
  }
}
