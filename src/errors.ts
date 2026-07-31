/**
 * Custom Error Types for NotebookLM MCP Server
 */

/**
 * Error thrown when NotebookLM rate limit is exceeded
 *
 * Limits vary by account and can change on Google's side.
 */
export class RateLimitError extends Error {
  constructor(message: string = "NotebookLM reported a rate or quota limit") {
    super(message);
    this.name = "RateLimitError";

    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RateLimitError);
    }
  }
}

export type ErrorCode =
  | "AUTH_REQUIRED"
  | "PROFILE_LOCKED"
  | "UI_CHANGED"
  | "TIMEOUT"
  | "QUOTA_EXCEEDED"
  | "SOURCE_NOT_READY"
  | "PERMISSION_DENIED"
  | "BROWSER_CRASHED"
  | "INVALID_ARGUMENT"
  | "OUTPUT_PATH_DENIED"
  | "INTERNAL_ERROR";

export interface StructuredToolError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  recommended_action?: string;
}

export function classifyError(error: unknown): StructuredToolError {
  const message = error instanceof Error ? error.message : String(error);
  const explicitCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const candidate = `${explicitCode} ${message}`;

  if (/INVALID_ARGUMENT/i.test(candidate)) {
    return { code: "INVALID_ARGUMENT", message, retryable: false };
  }
  if (/OUTPUT_PATH_DENIED/i.test(candidate)) {
    return { code: "OUTPUT_PATH_DENIED", message, retryable: false };
  }
  if (/UI_CHANGED|selector.*could not be detected/i.test(candidate)) {
    return {
      code: "UI_CHANGED",
      message,
      retryable: false,
      recommended_action: "Enable redacted diagnostics and update the affected selector group.",
    };
  }
  if (
    /AUTH_REQUIRED|requested sign-in|needs authentication|failed to authenticate/i.test(candidate)
  ) {
    return {
      code: "AUTH_REQUIRED",
      message,
      retryable: false,
      recommended_action: "Run setup_auth only after Google visibly requests sign-in.",
    };
  }
  if (/profile.*(?:locked|already in use)|ProcessSingleton/i.test(candidate)) {
    return { code: "PROFILE_LOCKED", message, retryable: true };
  }
  if (/rate limit|quota/i.test(candidate)) {
    return { code: "QUOTA_EXCEEDED", message, retryable: true };
  }
  if (/timeout|timed out/i.test(candidate)) {
    return { code: "TIMEOUT", message, retryable: true };
  }
  if (/has been closed|browser.*closed|context.*closed|page.*closed|crash/i.test(candidate)) {
    return { code: "BROWSER_CRASHED", message, retryable: true };
  }
  if (/permission|access denied|EACCES|EPERM/i.test(candidate)) {
    return { code: "PERMISSION_DENIED", message, retryable: false };
  }
  if (/source.*not.*ready|indexing/i.test(candidate)) {
    return { code: "SOURCE_NOT_READY", message, retryable: true };
  }
  return { code: "INTERNAL_ERROR", message, retryable: false };
}

/**
 * Error thrown when authentication fails
 *
 * This error can suggest cleanup workflow for persistent issues.
 * Especially useful when upgrading from old installation (notebooklm-mcp-nodejs).
 */
export class AuthenticationError extends Error {
  suggestCleanup: boolean;

  constructor(message: string, suggestCleanup: boolean = false) {
    super(message);
    this.name = "AuthenticationError";
    this.suggestCleanup = suggestCleanup;

    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AuthenticationError);
    }
  }
}
