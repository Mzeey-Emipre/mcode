import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import {
  compareSQLiteProfileReports,
  openSQLiteProfileDatabase,
  parseSQLiteProfileBaseline,
  parseSQLiteProfileCliOptions,
  runSQLiteProfile,
  type SQLiteProfileReport,
} from "../src/runtime/persistence/sqlite/performance/sqlite-profile.js";
import {
  createSQLiteCertificationReport,
  runSQLiteCacheBudgetCertification,
  runSQLiteRecoveryCertification,
  type SQLiteCertificationReport,
} from "../src/runtime/persistence/sqlite/performance/sqlite-certification.js";

const MAX_BASELINE_BYTES = 5 * 1024 * 1024;

const HELP = `Usage: bun run perf:database [options]

Options:
  --samples <3-50>             Samples per workload. Default: 20.
  --baseline <path>            Compare aggregate medians with a prior report.
  --threshold-percent <value>  Regression threshold. Default: 5.
  --output <path>              Write the JSON report to this path.
  --certify                    Require a baseline and run recovery certification.
  --help                       Show this help.`;

const options = parseSQLiteProfileCliOptions(process.argv.slice(2));
if (options.help) {
  console.log(HELP);
} else {
  if (options.certify && !options.baselinePath) {
    throw new Error("SQLite certification requires --baseline <path>.");
  }
  const baselinePath = options.baselinePath
    ? NodePath.resolve(options.baselinePath)
    : undefined;
  const baseline = baselinePath ? readBaseline(baselinePath) : undefined;
  const profileDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-sqlite-profile-"));
  try {
    const report = await runSQLiteProfile(options.samples, (workload, sample) => {
      const dbPath = NodePath.join(profileDirectory, `${sample}-${workload}.sqlite`);
      return openSQLiteProfileDatabase(dbPath);
    }, hostRuntime);

    if (baseline && baselinePath) {
      report.comparison = compareSQLiteProfileReports(
        report,
        baseline,
        baselinePath,
        options.thresholdPercent,
      );
    }

    const output = options.certify
      ? createSQLiteCertificationReport(
        report,
        runSQLiteRecoveryCertification(NodePath.join(profileDirectory, "recovery")),
        runSQLiteCacheBudgetCertification(NodePath.join(profileDirectory, "cache-budget")),
      )
      : report;
    writeReport(output, options.outputPath);
    if (
      report.comparison?.regressions.length
      || ("status" in output && output.status === "fail")
    ) {
      process.exitCode = 1;
    }
  } finally {
    NodeFS.rmSync(profileDirectory, { recursive: true, force: true });
  }
}

function readBaseline(
  baselinePath: string,
): ReturnType<typeof parseSQLiteProfileBaseline> {
  if (!NodeFS.existsSync(baselinePath)) {
    throw new Error(`Baseline report not found: ${baselinePath}`);
  }
  const baselineBytes = NodeFS.readFileSync(baselinePath);
  if (baselineBytes.byteLength > MAX_BASELINE_BYTES) {
    throw new Error(`Baseline report exceeds ${MAX_BASELINE_BYTES} bytes.`);
  }
  return parseSQLiteProfileBaseline(JSON.parse(baselineBytes.toString("utf8")));
}

function writeReport(
  report: SQLiteProfileReport | SQLiteCertificationReport,
  outputPath?: string,
): void {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    const resolvedOutputPath = NodePath.resolve(outputPath);
    NodeFS.mkdirSync(NodePath.dirname(resolvedOutputPath), { recursive: true });
    NodeFS.writeFileSync(resolvedOutputPath, json, { encoding: "utf8", flag: "w" });
  }
  process.stdout.write(json);
}
