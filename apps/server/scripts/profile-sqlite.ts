import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import {
  compareSQLiteProfileReports,
  openSQLiteProfileDatabase,
  parseSQLiteProfileBaseline,
  parseSQLiteProfileCliOptions,
  runSQLiteProfile,
  type SQLiteProfileReport,
} from "../src/performance/sqlite-profile.js";

const MAX_BASELINE_BYTES = 5 * 1024 * 1024;

const HELP = `Usage: bun run perf:database [options]

Options:
  --samples <3-50>             Samples per workload. Default: 20.
  --baseline <path>            Compare aggregate medians with a prior report.
  --threshold-percent <value>  Regression threshold. Default: 5.
  --output <path>              Write the JSON report to this path.
  --help                       Show this help.`;

const options = parseSQLiteProfileCliOptions(process.argv.slice(2));
if (options.help) {
  console.log(HELP);
} else {
  const profileDirectory = mkdtempSync(join(tmpdir(), "mcode-sqlite-profile-"));
  try {
    const report = runSQLiteProfile(options.samples, (workload, sample) => {
      const dbPath = join(profileDirectory, `${sample}-${workload}.sqlite`);
      return openSQLiteProfileDatabase(dbPath);
    });

    if (options.baselinePath) {
      const baselinePath = resolve(options.baselinePath);
      if (!existsSync(baselinePath)) throw new Error(`Baseline report not found: ${baselinePath}`);
      const baselineBytes = readFileSync(baselinePath);
      if (baselineBytes.byteLength > MAX_BASELINE_BYTES) throw new Error(`Baseline report exceeds ${MAX_BASELINE_BYTES} bytes.`);
      const baseline = parseSQLiteProfileBaseline(JSON.parse(baselineBytes.toString("utf8")));
      report.comparison = compareSQLiteProfileReports(
        report,
        baseline,
        baselinePath,
        options.thresholdPercent,
      );
    }

    writeReport(report, options.outputPath);
    if (report.comparison?.regressions.length) process.exitCode = 1;
  } finally {
    rmSync(profileDirectory, { recursive: true, force: true });
  }
}

function writeReport(report: SQLiteProfileReport, outputPath?: string): void {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    const resolvedOutputPath = resolve(outputPath);
    mkdirSync(dirname(resolvedOutputPath), { recursive: true });
    writeFileSync(resolvedOutputPath, json, { encoding: "utf8", flag: "w" });
  }
  process.stdout.write(json);
}
