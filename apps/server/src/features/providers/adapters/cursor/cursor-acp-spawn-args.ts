/**
 * Builds argv for `cursor-agent` / `agent acp` subprocesses.
 * Mirrors the supervised vs full-access flag matrix from {@link buildCursorTurnArgs}
 * so sandbox and trust semantics stay aligned with the `--print` transport.
 */

/** Args after the executable: `["acp", ...]` */
export function buildCursorAcpArgs(opts: {
  permissionMode: "default" | "full";
  /** Host platform; defaults to `process.platform` in the provider. */
  platform?: NodeJS.Platform;
}): string[] {
  const platform = opts.platform ?? process.platform;
  const args: string[] = ["acp"];
  if (opts.permissionMode === "full") {
    args.push("--force", "--sandbox", "disabled");
  } else {
    args.push("--trust");
    const supervisedSandboxAvailable = platform === "darwin" || platform === "linux";
    args.push("--sandbox", supervisedSandboxAvailable ? "enabled" : "disabled");
  }
  return args;
}
