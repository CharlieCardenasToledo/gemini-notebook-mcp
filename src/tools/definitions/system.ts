import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * System / auth / cleanup tools. The cross-tool first-run workflow lives in
 * the server-level `instructions` string (see src/index.ts) so individual
 * descriptions stay focused on what each tool does, not how the suite
 * fits together.
 */
export const systemTools: Tool[] = [
  {
    name: "get_health",
    description:
      "Inspect server state. Returns:\n" +
      "  • `auth_state_present` — whether a readable cookie backup exists\n" +
      "  • `authenticated` — `null`; live auth is checked when NotebookLM opens\n" +
      "  • `authentication_check` — explains where live verification occurs\n" +
      "  • `notebook_url`, `active_notebook_id`, `active_notebook_name` —\n" +
      "    the currently selected library notebook (or null)\n" +
      "  • `total_notebooks` — library size\n" +
      "  • `active_sessions`, `max_sessions`, `session_timeout` — runtime\n" +
      "    session stats (timeout in seconds; sessions auto-close after this)\n" +
      "  • `headless`, `auto_login_enabled`, `stealth_enabled` — config\n" +
      "Use this first thing in a new conversation for server diagnostics. " +
      "Do not run destructive auth tools from this result alone; `re_auth` is " +
      "only for switching accounts or a confirmed Google sign-in redirect.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      title: "Get server health",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "setup_auth",
    description:
      "Open a browser window for first-time Google login. Active MCP browser " +
      "sessions are closed first so the persistent Chrome profile can be used " +
      "exclusively during authentication. The tool call waits for completion " +
      "for up to 10 minutes while reporting progress, then persists cookies " +
      "for future runs. Existing profile data is preserved; use `re_auth` when " +
      "a clean login is required.\n\n" +
      "When to use:\n" +
      "  • This is the first run and Google requests sign-in\n" +
      "  • Auto-login credentials are not configured\n" +
      "  • `re_auth` is the right call when you want to switch accounts\n\n" +
      "After login finishes, a NotebookLM operation verifies the live session; " +
      "`get_health` only reports whether the saved backup is readable.\n\n" +
      "If the browser session remains broken, preview `cleanup_data` with " +
      "`preserve_library=true`, obtain explicit approval, then execute using " +
      "the returned preview token before retrying `setup_auth`.",
    inputSchema: {
      type: "object",
      properties: {
        show_browser: {
          type: "boolean",
          description:
            "Show the browser window. Default: true (must be visible so the " +
            "user can interact). For advanced control use `browser_options`.",
        },
        browser_options: {
          type: "object",
          description:
            "Advanced browser settings. Override visibility, timeout, or " +
            "headless mode (default: visible, 30 s).",
          properties: {
            show: { type: "boolean" },
            headless: { type: "boolean" },
            timeout_ms: { type: "number" },
          },
        },
      },
    },
    annotations: {
      title: "Set up Google authentication",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "re_auth",
    description:
      "Switch to a different Google account or recover from broken auth. " +
      "Closes all active sessions, deletes saved cookies and Chrome profile, " +
      "and opens a fresh login browser.\n\n" +
      "Common triggers:\n" +
      "  • Google reports an account quota and the user explicitly wants to " +
      "switch to another Google account\n" +
      "  • `setup_auth` failed and a clean slate is needed\n\n" +
      "After login, open NotebookLM to verify. For stuck states, use the " +
      "token-bound preview/confirm workflow of `cleanup_data` before `re_auth`.",
    inputSchema: {
      type: "object",
      properties: {
        show_browser: {
          type: "boolean",
          description: "Show the browser window. Default: true.",
        },
        browser_options: {
          type: "object",
          properties: {
            show: { type: "boolean" },
            headless: { type: "boolean" },
            timeout_ms: { type: "number" },
          },
        },
      },
    },
    annotations: {
      title: "Re-authenticate",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "cleanup_data",
    description:
      "Two-phase cleanup restricted to the configured NOTEBOOKLM_DATA_DIR. " +
      "It never scans or deletes npm caches, Claude/Cursor/VS Code data, " +
      "system temporary files, or trash. Close active browser sessions first.\n\n" +
      "Phase 1 (preview): call with `confirm: false`. Returns a categorised " +
      "list, digest, expiry, and one-time preview token. No deletion happens.\n" +
      "Phase 2 (delete): after the user reviews the preview and approves, " +
      "call with `confirm: true` and the exact `preview_token`. The operation " +
      "is rejected if the token expired or the path manifest changed.\n\n" +
      "Set `preserve_library: true` to keep the notebook library file " +
      "(library.json) while wiping everything else — recommended when " +
      "troubleshooting auth.\n\n" +
      "Typical recovery flow:\n" +
      "  1. cleanup_data(confirm=false, preserve_library=true)  // preview\n" +
      "  2. cleanup_data(confirm=true, preview_token=...)        // execute\n" +
      "  3. setup_auth (or re_auth)",
    inputSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          description:
            "false = preview only (default). true = actually delete after " +
            "user reviewed the preview.",
        },
        preserve_library: {
          type: "boolean",
          description:
            "Keep notebook library.json while deleting everything else. " +
            "Default: false. Set true when only auth/browser state is broken.",
          default: false,
        },
        preview_token: {
          type: "string",
          description:
            "One-time token returned by the immediately preceding preview. " +
            "Required when confirm=true and valid for five minutes.",
        },
      },
      required: ["confirm"],
    },
    annotations: {
      title: "Cleanup all data",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];
