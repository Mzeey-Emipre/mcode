import * as NodeFS from "node:fs";
import { sanitizeProviderFixtureFile, type ProviderFixtureSanitizerMetadata } from "./sanitizer.js";

const [rawFile, outputFile, metadataFile] = process.argv.slice(2);
if (!rawFile || !outputFile || !metadataFile) {
  throw new TypeError("Usage: bun run conformance:sanitize -- <raw.jsonl> <fixture.json> <metadata.json>");
}

const metadata = JSON.parse(NodeFS.readFileSync(metadataFile, "utf8")) as ProviderFixtureSanitizerMetadata;
const manifest = sanitizeProviderFixtureFile({ rawFile, outputFile, metadata });
process.stdout.write(`${manifest.providerId}:${manifest.scenario} ${manifest.sourceHash}\n`);
