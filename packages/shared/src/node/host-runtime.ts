/** Immutable facts about the Node runtime that hosts Mcode. */
export interface HostRuntime {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly nodeAbi: string;
}

/** Captures the host facts once at the Node boundary. */
export const hostRuntime: HostRuntime = Object.freeze({
  platform: process.platform,
  architecture: process.arch,
  nodeAbi: process.versions.modules,
});
