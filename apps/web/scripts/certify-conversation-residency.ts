import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  runConversationResidencyCertification,
  type ConversationCertificationRuntime,
} from "../src/performance/conversation-residency-certification.js";

const MAX_OUTPUT_PATH_LENGTH = 2_048;
const options = parseOptions(process.argv.slice(2));
const report = runConversationResidencyCertification(readCertificationRuntime(), options.samples);
const json = `${JSON.stringify(report, null, 2)}\n`;

if (options.outputPath) {
  const outputPath = NodePath.resolve(options.outputPath);
  NodeFS.mkdirSync(NodePath.dirname(outputPath), { recursive: true });
  NodeFS.writeFileSync(outputPath, json, { encoding: "utf8", flag: "w" });
}
process.stdout.write(json);
if (report.status === "fail") process.exitCode = 1;

interface CertificationOptions {
  samples: number;
  outputPath?: string;
}

/** Read runtime facts at the Node runner boundary before renderer-safe profiling starts. */
function readCertificationRuntime(): ConversationCertificationRuntime {
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    electronVersion: process.versions.electron ?? null,
  };
}

function parseOptions(args: string[]): CertificationOptions {
  const options: CertificationOptions = { samples: 10 };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--samples") {
      const value = args[++index];
      const samples = Number(value);
      if (!Number.isInteger(samples) || samples < 3 || samples > 50) {
        throw new Error("--samples must be an integer from 3 through 50.");
      }
      options.samples = samples;
    } else if (argument === "--output") {
      const outputPath = args[++index];
      if (!outputPath || outputPath.length > MAX_OUTPUT_PATH_LENGTH) {
        throw new Error(`--output must contain from 1 through ${MAX_OUTPUT_PATH_LENGTH} characters.`);
      }
      options.outputPath = outputPath;
    } else {
      throw new Error(`Unknown conversation certification option: ${String(argument)}`);
    }
  }
  return options;
}
