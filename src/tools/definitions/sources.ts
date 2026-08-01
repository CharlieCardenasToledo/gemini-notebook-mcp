/**
 * MCP tool definitions for source ingestion + Audio Overview (issues #25, #11).
 *
 * The cross-tool async-audio chain (generate → poll → download) is documented
 * in the server-level `instructions` string (see src/index.ts) so individual
 * descriptions stay focused on one operation each.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const sharedNotebookTargeting = {
  session_id: {
    type: "string",
    format: "uuid",
    description:
      "Reuse an existing browser session by id. Recommended when you have " +
      "already called `ask_question` against the same notebook — saves the " +
      "10–15 s page-load time. Obtain from `list_sessions` or any prior " +
      "`ask_question` response (`result.session_id`).",
  },
  notebook_id: {
    type: "string",
    description:
      "Library notebook id (from `list_notebooks` / `search_notebooks`). " +
      "Defaults to the active notebook (see `select_notebook`) when omitted.",
  },
  notebook_url: {
    type: "string",
    description:
      "Direct NotebookLM URL — overrides `notebook_id`. Use for ad-hoc " +
      "notebooks not yet in your library. Format: " +
      "`https://notebook.google.com/notebook/<uuid>` (the legacy " +
      "`notebooklm.google.com` host is also accepted).",
  },
};

export const addSourceTool: Tool = {
  name: "add_source",
  description:
    "Ingest a source into a NotebookLM notebook. Supports three source types " +
    "in the current browser backend:\n" +
    "  • `url` — NotebookLM crawls and indexes a website\n" +
    "  • `text` — paste raw text (treated as a copied document)\n" +
    "  • `youtube` — import a public YouTube URL\n\n" +
    "File and Google-Drive uploads are not yet exposed because their picker flows require additional permission and path controls.\n\n" +
    "Returns `sourceCountBefore`/`sourceCountAfter` plus a `correlation` status. " +
    "A `source` object is returned only after an exact canonical-URL match with a Google-exposed stable ID, or an exact requested-title match; " +
    "`accepted_unverified` and `ambiguous` mean the submission was accepted but no safe identity could be assigned. " +
    "Do not retry those outcomes automatically—use `list_sources` to reconcile. Call once per source; multiple sources require " +
    "multiple calls. NotebookLM finishes indexing within 5–30 seconds; " +
    "subsequent `ask_question` calls then have the new source in context. " +
    "Account and source limits vary; rely on the live Google interface.\n\n" +
    "Known quirk: pasted-text uploads occasionally redirect to a freshly " +
    'created "Untitled notebook" on Google\'s side. The tool detects this ' +
    "and returns a clear error so you can re-try against the correct URL.",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["url", "text", "youtube"],
        description:
          "`url` crawls a website; `youtube` imports a public video URL; " +
          "`text` ingests `content` verbatim as a copied document.",
      },
      content: {
        type: "string",
        description:
          "When `type=url`: a fully-qualified URL (https://…). " +
          "When `type=text`: the raw text body, subject to the current per-source limit shown by NotebookLM.",
      },
      title: {
        type: "string",
        description:
          "Display title shown in the source list. Optional — NotebookLM " +
          "picks a sensible default (page title for URLs, first line for text). " +
          "For text sources, supplying a title is recommended for later " +
          "identification.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["type", "content"],
  },
  annotations: {
    title: "Add source to notebook",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const listSourcesTool: Tool = {
  name: "list_sources",
  description:
    "Read the sources currently shown in a notebook sidebar. Returns a stable best-effort `source_id`, name, inferred type, indexing status, URL when exposed by the UI, and position. An empty list is returned only after the source panel was successfully inspected.",
  inputSchema: {
    type: "object",
    properties: { show_browser: { type: "boolean" }, ...sharedNotebookTargeting },
  },
  annotations: { title: "List notebook sources", readOnlyHint: true, openWorldHint: true },
};

export const getSourceTool: Tool = {
  name: "get_source",
  description:
    "Get one source from the current notebook inventory by `source_id` (preferred) or exact `name`. Use `list_sources` first when the identifier is unknown.",
  inputSchema: {
    type: "object",
    properties: {
      source_id: { type: "string", description: "Source id returned by `list_sources`." },
      name: { type: "string", description: "Exact visible source name." },
      show_browser: { type: "boolean" },
      ...sharedNotebookTargeting,
    },
  },
  annotations: { title: "Get notebook source", readOnlyHint: true, openWorldHint: true },
};

export const getSourceStatusTool: Tool = {
  ...getSourceTool,
  name: "get_source_status",
  description:
    "Refresh one source from the current notebook inventory and return its indexing `status` plus the same structured source fields as `get_source`.",
  annotations: { title: "Get source indexing status", readOnlyHint: true, openWorldHint: true },
};

export const batchAddSourcesTool: Tool = {
  name: "batch_add_sources",
  description:
    "Add up to 25 URL, YouTube, or pasted-text sources sequentially in one authenticated notebook session. Stops on the first failure by default and returns counts plus safe correlation status for every attempted item; concurrent additions are never assigned to the current item without an exact match.",
  inputSchema: {
    type: "object",
    properties: {
      sources: {
        type: "array",
        maxItems: 25,
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["url", "text", "youtube"] },
            content: { type: "string" },
            title: { type: "string" },
          },
          required: ["type", "content"],
        },
      },
      stop_on_error: { type: "boolean", description: "Default true." },
      show_browser: { type: "boolean" },
      ...sharedNotebookTargeting,
    },
    required: ["sources"],
  },
  annotations: {
    title: "Batch add notebook sources",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const generateArtifactTool: Tool = {
  name: "generate_artifact",
  description:
    "Start a persistent Studio artifact job. Version 2.3 supports `audio_overview`; the generic job shape allows more Studio artifact types to be added without multiplying tools. Returns a `job_id` that survives MCP restarts.",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["audio_overview"] },
      custom_prompt: { type: "string" },
      wait_for_completion: { type: "boolean" },
      timeout_ms: { type: "number" },
      show_browser: { type: "boolean" },
      ...sharedNotebookTargeting,
    },
    required: ["type"],
  },
  annotations: {
    title: "Generate Studio artifact",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const listArtifactsTool: Tool = {
  name: "list_artifacts",
  description:
    "List persistent Studio jobs created by this MCP client. Optionally filter by notebook. This reads the local job registry and does not open a browser.",
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: sharedNotebookTargeting.notebook_id,
      notebook_url: sharedNotebookTargeting.notebook_url,
    },
  },
  annotations: { title: "List Studio artifacts", readOnlyHint: true, openWorldHint: false },
};

export const getArtifactStatusTool: Tool = {
  name: "get_artifact_status",
  description:
    "Refresh and return a persistent Studio job by `job_id`. For an Audio Overview this probes the live notebook and stores the updated ready/in-progress state.",
  inputSchema: {
    type: "object",
    properties: { job_id: { type: "string", format: "uuid" }, show_browser: { type: "boolean" } },
    required: ["job_id"],
  },
  annotations: { title: "Get artifact status", readOnlyHint: true, openWorldHint: true },
};

export const downloadArtifactTool: Tool = {
  name: "download_artifact",
  description:
    "Download a ready artifact job under NOTEBOOKLM_OUTPUT_DIR and persist the resulting path in the job registry.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string", format: "uuid" },
      destination_dir: { type: "string" },
      show_browser: { type: "boolean" },
    },
    required: ["job_id", "destination_dir"],
  },
  annotations: {
    title: "Download Studio artifact",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const generateAudioTool: Tool = {
  name: "generate_audio",
  description:
    "Trigger podcast-style Audio Overview generation for a notebook.\n\n" +
    "**Async by default** — returns immediately with one of:\n" +
    '  • `status: "started"` — generation just kicked off\n' +
    '  • `status: "in_progress"` — a generation was already running; ' +
    "this call attached to it\n" +
    '  • `status: "ready"` (with `alreadyExisted: true`) — an Audio ' +
    "Overview already existed; nothing was triggered\n\n" +
    "Generation typically takes 2–10 minutes. **Workflow:**\n" +
    "  1. `generate_audio` → returns immediately\n" +
    "  2. Poll `get_audio_status` every ~30 s\n" +
    "  3. When status is `ready`, call `download_audio`\n\n" +
    "Pass `wait_for_completion: true` for legacy synchronous behaviour " +
    "(blocks for up to `timeout_ms`). Audio Overview is the only Studio " +
    "output currently exposed (Video / Mindmap / Quiz / Infographic / " +
    "Datatable / Presentation are NotebookLM features but not yet wrapped).",
  inputSchema: {
    type: "object",
    properties: {
      custom_prompt: {
        type: "string",
        description:
          'Optional focus prompt for the Audio Overview, e.g. "Focus on the ' +
          'API authentication flow and skip pricing". Passed into the ' +
          'NotebookLM "Customize" sub-dialog before generation starts.',
      },
      wait_for_completion: {
        type: "boolean",
        description:
          "If true, block until the audio tile is ready (up to `timeout_ms`). " +
          "Default false — return immediately and let the caller poll " +
          "`get_audio_status`.",
      },
      timeout_ms: {
        type: "number",
        description:
          "Only relevant when `wait_for_completion=true`. Maximum wait for " +
          "the audio tile to appear. Default 600 000 (10 min).",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
  },
  annotations: {
    title: "Generate Audio Overview",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true, // Idempotent: existing audio is detected and returned as ready
    openWorldHint: true,
  },
};

export const getAudioStatusTool: Tool = {
  name: "get_audio_status",
  description:
    "Non-blocking probe for the current Audio Overview state of a notebook.\n\n" +
    "Returned `status` values:\n" +
    "  • `ready` — Audio Overview is generated and ready to download\n" +
    "  • `in_progress` — generation is currently running\n" +
    "  • `not_started` — no Audio Overview exists yet for this notebook\n\n" +
    "Safe to poll every ~30 s while waiting for `generate_audio` to finish. " +
    "When status flips to `ready`, call `download_audio` with a destination " +
    "directory.",
  inputSchema: {
    type: "object",
    properties: {
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
  },
  annotations: {
    title: "Get Audio Overview status",
    readOnlyHint: true,
    openWorldHint: true,
  },
};

export const downloadAudioTool: Tool = {
  name: "download_audio",
  description:
    "Save the completed Audio Overview to disk as a `.m4a` file. **Pre-" +
    'condition:** `get_audio_status` must report `status: "ready"`. ' +
    "Calling this before generation completes returns an error message " +
    "explaining what to do.\n\n" +
    "The file lands under NOTEBOOKLM_OUTPUT_DIR, using `destination_dir` " +
    "as a relative subdirectory (or an absolute path inside that root), with NotebookLM's suggested " +
    "filename (sanitised — usually the audio's title with underscores). " +
    "The full saved path is returned in `result.filePath`.",
  inputSchema: {
    type: "object",
    properties: {
      destination_dir: {
        type: "string",
        description:
          "Directory under NOTEBOOKLM_OUTPUT_DIR where the file is saved " +
          "(created if missing). Use `.` for the configured output root. " +
          "Absolute paths are accepted only when they remain inside that root.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["destination_dir"],
  },
  annotations: {
    title: "Download Audio Overview",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const sourceTools: Tool[] = [
  addSourceTool,
  listSourcesTool,
  getSourceTool,
  getSourceStatusTool,
  batchAddSourcesTool,
  generateArtifactTool,
  listArtifactsTool,
  getArtifactStatusTool,
  downloadArtifactTool,
  generateAudioTool,
  getAudioStatusTool,
  downloadAudioTool,
];
