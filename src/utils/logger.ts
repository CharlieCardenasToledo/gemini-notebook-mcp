/** Privacy-preserving stderr logging for the MCP server. */

import { createHash } from "node:crypto";

export type LogLevel = "info" | "success" | "warning" | "error" | "debug" | "dim";
type ConfiguredLogLevel = "silent" | "error" | "warning" | "info" | "debug";
type LogFormat = "text" | "json";

interface LogStyle {
  prefix: string;
  color: string;
}

export interface LoggerOptions {
  enabled?: boolean;
  level?: ConfiguredLogLevel;
  format?: LogFormat;
  content?: boolean;
  diagnostics?: boolean;
  sink?: (message: string) => void;
}

const STYLES: Record<LogLevel, LogStyle> = {
  info: { prefix: "ℹ️", color: "\x1b[36m" },
  success: { prefix: "✅", color: "\x1b[32m" },
  warning: { prefix: "⚠️", color: "\x1b[33m" },
  error: { prefix: "❌", color: "\x1b[31m" },
  debug: { prefix: "🔍", color: "\x1b[35m" },
  dim: { prefix: "  ", color: "\x1b[2m" },
};

const PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warning: 1,
  info: 2,
  success: 2,
  debug: 3,
  dim: 3,
};

const THRESHOLD: Record<ConfiguredLogLevel, number> = {
  silent: -1,
  error: 0,
  warning: 1,
  info: 2,
  debug: 3,
};

const RESET = "\x1b[0m";

export class Logger {
  private enabled: boolean;
  private level: ConfiguredLogLevel;
  private format: LogFormat;
  private contentEnabled: boolean;
  private diagnosticsEnabled: boolean;
  private sink: (message: string) => void;

  constructor(options: boolean | LoggerOptions = {}) {
    const normalized = typeof options === "boolean" ? { enabled: options } : options;
    this.enabled = normalized.enabled ?? true;
    this.level = normalized.level ?? parseLogLevel(process.env.LOG_LEVEL);
    this.format = normalized.format ?? parseLogFormat(process.env.LOG_FORMAT);
    this.contentEnabled = normalized.content ?? parseBoolean(process.env.LOG_CONTENT, false);
    this.diagnosticsEnabled =
      normalized.diagnostics ?? parseBoolean(process.env.LOG_DIAGNOSTICS, false);
    this.sink = normalized.sink ?? ((message) => console.error(message));
  }

  log(message: string, level: LogLevel = "info"): void {
    if (!this.enabled || THRESHOLD[this.level] < PRIORITY[level]) return;

    const timestamp = new Date().toISOString();
    const safeMessage = this.contentEnabled ? message : redactSensitive(message);
    if (this.format === "json") {
      this.sink(
        JSON.stringify({
          timestamp,
          level: normalizeLevel(level),
          message: safeMessage,
        })
      );
      return;
    }

    const style = STYLES[level];
    const time = timestamp.split("T")[1].slice(0, 8);
    this.sink(`${style.color}${style.prefix}  [${time}] ${safeMessage}${RESET}`);
  }

  info(message: string): void {
    this.log(message, "info");
  }

  success(message: string): void {
    this.log(message, "success");
  }

  warning(message: string): void {
    this.log(message, "warning");
  }

  error(message: string): void {
    this.log(message, "error");
  }

  debug(message: string): void {
    this.log(message, "debug");
  }

  dim(message: string): void {
    this.log(message, "dim");
  }

  /** Log user/source content only after explicit LOG_CONTENT opt-in. */
  content(label: string, value: string): void {
    if (!this.contentEnabled) return;
    this.log(`${label}: ${value}`, "info");
  }

  /** Log DOM snippets and detailed browser diagnostics only after opt-in. */
  diagnostic(label: string, value: string): void {
    if (!this.diagnosticsEnabled) return;
    this.log(`${label}: ${value}`, "debug");
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

export function hashLogValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function redactSensitive(message: string): string {
  return message
    .replace(/SyntaxError:[\s\S]*/g, "SyntaxError: details redacted")
    .replace(/https?:\/\/[^\s"')]+/gi, "[redacted-url]")
    .replace(/[A-Z]:\\[^\r\n"']+/gi, "[redacted-path]")
    .replace(/\/(?:Users|home|tmp|var|private|opt|srv)\/[^\r\n"']+/g, "[redacted-path]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .slice(0, 2000);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["true", "1", "yes"].includes(value.trim().toLowerCase());
}

function parseLogLevel(value: string | undefined): ConfiguredLogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "warn") return "warning";
  if (
    normalized === "silent" ||
    normalized === "error" ||
    normalized === "warning" ||
    normalized === "info" ||
    normalized === "debug"
  ) {
    return normalized;
  }
  return "info";
}

function parseLogFormat(value: string | undefined): LogFormat {
  return value?.trim().toLowerCase() === "json" ? "json" : "text";
}

function normalizeLevel(level: LogLevel): "debug" | "info" | "warning" | "error" {
  if (level === "success") return "info";
  if (level === "dim") return "debug";
  return level;
}

export const logger = new Logger();

export const log = {
  info: (msg: string) => logger.info(msg),
  success: (msg: string) => logger.success(msg),
  warning: (msg: string) => logger.warning(msg),
  error: (msg: string) => logger.error(msg),
  debug: (msg: string) => logger.debug(msg),
  dim: (msg: string) => logger.dim(msg),
  content: (label: string, value: string) => logger.content(label, value),
  diagnostic: (label: string, value: string) => logger.diagnostic(label, value),
};
