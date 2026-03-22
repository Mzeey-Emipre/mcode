/**
 * Application logger with daily rotation and console output.
 * Ported from the tracing setup in apps/desktop/src/lib.rs (lines 270-285).
 */

import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_DIR = join(homedir(), ".mcode", "logs");
const MAX_LINES = 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

// Ensure log directory exists at import time
mkdirSync(LOG_DIR, { recursive: true });

export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: "mcode.log.%DATE%",
      datePattern: "YYYY-MM-DD",
      maxFiles: "14d",
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
  ],
});

/** Get the path to the log directory. */
export function getLogPath(): string {
  return LOG_DIR;
}

/**
 * Read the most recent log file and return the last N lines.
 * Mirrors the Rust get_recent_logs command, including the 10 MB guard
 * and 1000-line cap.
 */
export function getRecentLogs(lines: number): string {
  const cappedLines = Math.min(Math.max(lines, 0), MAX_LINES);

  const files = readdirSync(LOG_DIR)
    .filter((f) => f.startsWith("mcode.log"))
    .map((f) => ({
      name: f,
      mtime: statSync(join(LOG_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) return "";

  const latestPath = join(LOG_DIR, files[0].name);
  const stat = statSync(latestPath);

  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      "Log file exceeds 10MB, please check ~/.mcode/logs/ directly",
    );
  }

  const content = readFileSync(latestPath, "utf-8");
  const allLines = content.split("\n");

  return allLines.slice(-cappedLines).join("\n");
}
