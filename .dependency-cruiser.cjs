/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "web-does-not-import-server-or-desktop",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^apps/(?:server|desktop)/" },
    },
    {
      name: "contracts-does-not-import-apps-or-providers",
      severity: "error",
      from: { path: "^packages/contracts/" },
      to: { path: "^(?:apps/|packages/providers/)" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "./tsconfig.dependency-cruiser.json",
    },
  },
};
