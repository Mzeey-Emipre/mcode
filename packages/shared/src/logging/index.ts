/**
 * Application logger with daily rotation and console output.
 * Provides a pre-configured Winston logger that writes JSON-formatted
 * entries to rotating files under `<MCODE_DIR>/logs/`.
 */

import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { getMcodeDir } from "../paths/index.js";

const LOG_DIR = join(getMcodeDir(), "logs");
const MAX_LINES = 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

// Ensure log directory exists at import time
mkdirSync(LOG_DIR, { recursive: true });

/** Pre-configured application logger with daily file rotation and console output. */
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

/** Get the absolute path to the log directory. */
export function getLogPath(): string {
  return LOG_DIR;
}

/**
 * Read the most recent log file and return the last N lines.
 * Enforces a 10 MB file-size guard and a 1000-line cap.
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
      `Log file exceeds 10MB, please check ${LOG_DIR} directly`,
    );
  }

  const content = readFileSync(latestPath, "utf-8");
  const allLines = content.split("\n");

  return allLines.slice(-cappedLines).join("\n");
}
