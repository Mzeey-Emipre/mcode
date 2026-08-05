const npmDependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/**
 * Remove npm-incompatible workspace protocol entries from dependency fields.
 *
 * @param {Record<string, unknown>} manifest
 * @returns {Record<string, unknown>}
 */
export function sanitizePackageManifest(manifest) {
  const sanitizedManifest = { ...manifest };

  for (const field of npmDependencyFields) {
    const dependencies = manifest[field];
    if (
      dependencies === null ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies)
    ) {
      continue;
    }

    const filteredDependencies = {};
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version === "string" && version.startsWith("workspace:")) {
        continue;
      }
      filteredDependencies[name] = version;
    }
    sanitizedManifest[field] = filteredDependencies;
  }

  return sanitizedManifest;
}
