export type LiveCheckDisposition = "skip" | "fail";

interface ToolFailureLike {
  error?: unknown;
  error_details?: {
    code?: unknown;
  };
}

const SKIP_CODES = new Set(["AUTH_REQUIRED", "PROFILE_LOCKED"]);

export function classifyLiveFailure(payload: ToolFailureLike): LiveCheckDisposition {
  const code = typeof payload.error_details?.code === "string" ? payload.error_details.code : "";
  if (SKIP_CODES.has(code)) return "skip";

  const message = typeof payload.error === "string" ? payload.error : "";
  if (
    /authentication|sign[- ]?in|not authenticated|no notebook selected|no active notebook|profile.*(?:locked|in use)/i.test(
      message
    )
  ) {
    return "skip";
  }
  return "fail";
}

export function redactLiveDiagnostic(value: unknown, maxLength = 240): string {
  const rendered = value instanceof Error ? value.message : String(value ?? "");
  return rendered
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/[A-Z]:\\(?:[^\s"'<>]+\\)*[^\s"'<>]*/gi, "[redacted-path]")
    .replace(/(^|\s)\/(?:Users|home|var|tmp|opt|private|Volumes)\/[^\s"'<>]*/g, "$1[redacted-path]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "[redacted-id]"
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function extractToolPayload(result: {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>;
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Tool result did not contain structuredContent or JSON text");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Tool result JSON was not an object");
  return parsed as Record<string, unknown>;
}
