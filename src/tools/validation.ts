import { z } from "zod";
import { normalizeNotebookUrl } from "../notebooklm/url.js";

const boundedString = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().max(max).optional();
const stringList = z.array(z.string().trim().min(1).max(500)).max(100);
const sessionId = z.string().uuid();
const notebookId = boundedString(200);
const notebookUrl = z
  .string()
  .max(2_048)
  .refine(
    (value) => {
      try {
        normalizeNotebookUrl(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "must be a valid HTTPS Google NotebookLM notebook URL" }
  );

const stealthSchema = z
  .object({
    enabled: z.boolean().optional(),
    random_delays: z.boolean().optional(),
    human_typing: z.boolean().optional(),
    mouse_movements: z.boolean().optional(),
    typing_wpm_min: z.number().finite().min(1).max(1_000).optional(),
    typing_wpm_max: z.number().finite().min(1).max(1_000).optional(),
    delay_min_ms: z.number().int().min(0).max(60_000).optional(),
    delay_max_ms: z.number().int().min(0).max(60_000).optional(),
  })
  .strict()
  .optional();

const browserOptionsSchema = z
  .object({
    show: z.boolean().optional(),
    headless: z.boolean().optional(),
    timeout_ms: z.number().int().min(1_000).max(1_800_000).optional(),
    answer_timeout_ms: z.number().int().min(1_000).max(1_800_000).optional(),
    stealth: stealthSchema,
    viewport: z
      .object({
        width: z.number().int().min(320).max(7_680),
        height: z.number().int().min(240).max(4_320),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const notebookTarget = {
  session_id: sessionId.optional(),
  notebook_id: notebookId.optional(),
  notebook_url: notebookUrl.optional(),
};

const sourceInputSchema = z
  .object({
    type: z.enum(["url", "text", "youtube"]),
    content: boundedString(5_000_000),
    title: optionalText(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === "text") return;
    try {
      const url = new URL(value.content);
      if (url.protocol !== "https:") throw new Error();
      if (value.type === "youtube" && !/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(url.hostname)) {
        context.addIssue({ code: "custom", path: ["content"], message: "must be a YouTube URL" });
      }
    } catch {
      context.addIssue({ code: "custom", path: ["content"], message: "must be a valid HTTPS URL" });
    }
  });

const emptySchema = z.object({}).strict();
const idSchema = z.object({ id: notebookId }).strict();

const schemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  ask_question: z
    .object({
      question: boundedString(50_000),
      ...notebookTarget,
      source_format: z.enum(["none", "inline", "footnotes", "json"]).optional(),
      show_browser: z.boolean().optional(),
      browser_options: browserOptionsSchema,
    })
    .strict(),
  add_notebook: z
    .object({
      url: notebookUrl,
      name: boundedString(200),
      description: z.string().max(10_000),
      topics: stringList,
      content_types: stringList.optional(),
      use_cases: stringList.optional(),
      tags: stringList.optional(),
    })
    .strict(),
  list_notebooks: emptySchema,
  list_account_notebooks: emptySchema,
  import_account_notebook: z
    .object({
      google_notebook_id: boundedString(200),
      description: z.string().max(10_000).optional(),
      topics: stringList.optional(),
      content_types: stringList.optional(),
      use_cases: stringList.optional(),
      tags: stringList.optional(),
    })
    .strict(),
  sync_library: z.object({ apply: z.boolean().optional() }).strict(),
  get_notebook: idSchema,
  select_notebook: idSchema,
  update_notebook: z
    .object({
      id: notebookId,
      name: boundedString(200).optional(),
      description: z.string().max(10_000).optional(),
      topics: stringList.optional(),
      content_types: stringList.optional(),
      use_cases: stringList.optional(),
      tags: stringList.optional(),
      url: notebookUrl.optional(),
    })
    .strict(),
  remove_notebook: idSchema,
  search_notebooks: z.object({ query: boundedString(1_000) }).strict(),
  get_library_stats: emptySchema,
  list_sessions: emptySchema,
  close_session: z.object({ session_id: sessionId }).strict(),
  reset_session: z.object({ session_id: sessionId }).strict(),
  get_health: emptySchema,
  setup_auth: z
    .object({ show_browser: z.boolean().optional(), browser_options: browserOptionsSchema })
    .strict(),
  re_auth: z
    .object({ show_browser: z.boolean().optional(), browser_options: browserOptionsSchema })
    .strict(),
  cleanup_data: z
    .object({
      confirm: z.boolean(),
      preserve_library: z.boolean().optional(),
      preview_token: z.string().min(32).max(100).optional(),
    })
    .strict(),
  add_source: z
    .object({
      type: z.enum(["url", "text", "youtube"]),
      content: boundedString(5_000_000),
      title: optionalText(500),
      show_browser: z.boolean().optional(),
      ...notebookTarget,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.type === "text") return;
      try {
        const url = new URL(value.content);
        if (url.protocol !== "https:") throw new Error();
        if (
          value.type === "youtube" &&
          !/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(url.hostname)
        ) {
          context.addIssue({ code: "custom", path: ["content"], message: "must be a YouTube URL" });
        }
      } catch {
        context.addIssue({
          code: "custom",
          path: ["content"],
          message: "must be a valid HTTPS URL",
        });
      }
    }),
  list_sources: z.object({ show_browser: z.boolean().optional(), ...notebookTarget }).strict(),
  get_source: z
    .object({
      source_id: boundedString(500).optional(),
      name: boundedString(500).optional(),
      show_browser: z.boolean().optional(),
      ...notebookTarget,
    })
    .strict()
    .refine((value) => Boolean(value.source_id || value.name), {
      message: "source_id or name is required",
    }),
  get_source_status: z
    .object({
      source_id: boundedString(500).optional(),
      name: boundedString(500).optional(),
      show_browser: z.boolean().optional(),
      ...notebookTarget,
    })
    .strict()
    .refine((value) => Boolean(value.source_id || value.name), {
      message: "source_id or name is required",
    }),
  batch_add_sources: z
    .object({
      sources: z.array(sourceInputSchema).min(1).max(25),
      stop_on_error: z.boolean().optional(),
      show_browser: z.boolean().optional(),
      ...notebookTarget,
    })
    .strict(),
  generate_artifact: z
    .object({
      type: z.literal("audio_overview"),
      custom_prompt: optionalText(50_000),
      timeout_ms: z.number().int().min(1_000).max(1_800_000).optional(),
      wait_for_completion: z.boolean().optional(),
      show_browser: z.boolean().optional(),
      ...notebookTarget,
    })
    .strict(),
  list_artifacts: z
    .object({ notebook_id: notebookId.optional(), notebook_url: notebookUrl.optional() })
    .strict(),
  get_artifact_status: z
    .object({ job_id: z.string().uuid(), show_browser: z.boolean().optional() })
    .strict(),
  download_artifact: z
    .object({
      job_id: z.string().uuid(),
      destination_dir: z.string().trim().max(1_024).default("."),
      show_browser: z.boolean().optional(),
    })
    .strict(),
  generate_audio: z
    .object({
      custom_prompt: optionalText(50_000),
      timeout_ms: z.number().int().min(1_000).max(1_800_000).optional(),
      wait_for_completion: z.boolean().optional(),
      show_browser: z.boolean().optional(),
      ...notebookTarget,
    })
    .strict(),
  get_audio_status: z.object({ show_browser: z.boolean().optional(), ...notebookTarget }).strict(),
  download_audio: z
    .object({
      destination_dir: z.string().trim().max(1_024).default("."),
      show_browser: z.boolean().optional(),
      ...notebookTarget,
    })
    .strict(),
};

export class InvalidToolArgumentsError extends Error {
  readonly code = "INVALID_ARGUMENT";

  constructor(toolName: string, details: string) {
    super(`INVALID_ARGUMENT for ${toolName}: ${details}`);
    this.name = "InvalidToolArgumentsError";
  }
}

export function validateToolArguments(toolName: string, args: unknown): Record<string, unknown> {
  const schema = schemas[toolName];
  if (!schema) return {};
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return parsed.data;

  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
    .join("; ");
  throw new InvalidToolArgumentsError(toolName, details);
}
