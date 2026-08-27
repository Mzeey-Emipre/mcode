/** Returns true when Cursor explicitly advertises HTTP MCP support. */
export function cursorSupportsHttpMcp(initializeResult: {
  agentCapabilities?: { mcpCapabilities?: { http?: boolean } };
}): boolean {
  return initializeResult.agentCapabilities?.mcpCapabilities?.http === true;
}
