/**
 * MCP Tool Handlers
 *
 * Implements the logic for all MCP tools.
 */

import type { SessionManager, AccountNotebookSummary } from "../session/session-manager.js";
import type { AuthManager } from "../auth/auth-manager.js";
import type { NotebookLibrary } from "../library/notebook-library.js";
import type {
  AddNotebookInput,
  LibraryStats,
  NotebookEntry,
  UpdateNotebookInput,
  LibrarySyncResult,
} from "../library/types.js";
import type { AddSourceInput, AddSourceResult, SourceSummary } from "../notebooklm/sources.js";
import type { AudioGenerationResult, DownloadAudioResult } from "../notebooklm/audio.js";
import { resolveOutputDirectory } from "../notebooklm/audio.js";
import { CONFIG, applyBrowserOptions, withRuntimeConfig, type BrowserOptions } from "../config.js";
import { hashLogValue, log } from "../utils/logger.js";
import type { AskQuestionResult, ToolResult, ProgressCallback } from "../types.js";
import { RateLimitError } from "../errors.js";
import { CleanupManager } from "../utils/cleanup-manager.js";
import { applyAiMarker, PROVENANCE } from "../utils/disclaimer.js";
import {
  ArtifactStore,
  type ArtifactJob,
  type ArtifactType,
} from "../notebooklm/artifact-store.js";

/**
 * Follow-up reminder appended to ask_question answers when explicitly enabled.
 * Off by default in v2 (issue #28) — the imperative phrasing reads like
 * adversarial prompt injection to safety-trained host agents and creates
 * noisy false positives. Opt back in via `NOTEBOOKLM_FOLLOW_UP_REMINDER=true`.
 */
const FOLLOW_UP_REMINDER =
  "\n\nIs that all you need to know? You can always ask another question using the same session ID. Before you reply to the user, review their original request and this answer; if anything is still unclear or missing, ask another question first.";

// Artifact jobs belong to the one Google profile configured for this server,
// not to an ephemeral MCP transport session, so they survive reconnects.
const ARTIFACT_OWNER_ID = "configured-google-profile";

function followUpReminderEnabled(): boolean {
  const raw = process.env.NOTEBOOKLM_FOLLOW_UP_REMINDER;
  if (raw === undefined) return false;
  const lower = raw.trim().toLowerCase();
  return lower === "true" || lower === "1" || lower === "yes";
}

/**
 * MCP Tool Handlers
 */
export class ToolHandlers {
  private sessionManager: SessionManager;
  private authManager: AuthManager;
  private library: NotebookLibrary;
  private cleanupManager: CleanupManager;
  private ownerId: string;
  private artifactStore: ArtifactStore;

  constructor(
    sessionManager: SessionManager,
    authManager: AuthManager,
    library: NotebookLibrary,
    ownerId = "local-stdio-client",
    artifactStore = new ArtifactStore()
  ) {
    this.sessionManager = sessionManager;
    this.authManager = authManager;
    this.library = library;
    this.cleanupManager = new CleanupManager();
    this.ownerId = ownerId;
    this.artifactStore = artifactStore;
  }

  /**
   * Handle ask_question tool
   */
  async handleAskQuestion(
    args: {
      question: string;
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
      browser_options?: BrowserOptions;
      source_format?: "none" | "inline" | "footnotes" | "json";
    },
    sendProgress?: ProgressCallback,
    signal?: AbortSignal
  ): Promise<ToolResult<AskQuestionResult>> {
    const {
      question,
      session_id,
      notebook_id,
      notebook_url,
      show_browser,
      browser_options,
      source_format = "none",
    } = args;

    log.info(`🔧 [TOOL] ask_question called`);
    log.info(`  Question characters: ${question.length}`);
    if (session_id) {
      log.info(`  Session ID hash: ${hashLogValue(session_id)}`);
    }
    if (notebook_id) {
      log.info(`  Notebook ID hash: ${hashLogValue(notebook_id)}`);
    }

    try {
      // Resolve notebook URL
      let resolvedNotebookUrl = notebook_url;

      if (!resolvedNotebookUrl && notebook_id) {
        const notebook = this.library.incrementUseCount(notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${notebook_id}`);
        }

        resolvedNotebookUrl = notebook.url;
        log.info(`  Resolved notebook from library`);
      } else if (!resolvedNotebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          const notebook = this.library.incrementUseCount(active.id);
          if (!notebook) {
            throw new Error(`Active notebook not found: ${active.id}`);
          }
          resolvedNotebookUrl = notebook.url;
          log.info(`  Using active notebook`);
        }
      }

      // Progress: Getting or creating session
      await sendProgress?.("Getting or creating browser session...", 1, 5);

      // Keep browser overrides scoped to this asynchronous call. This is
      // concurrency-safe under Streamable HTTP.
      const effectiveConfig = applyBrowserOptions(browser_options, show_browser);

      // Advanced browser_options take precedence over the legacy shorthand.
      let overrideHeadless: boolean | undefined = undefined;
      if (browser_options?.show !== undefined) {
        overrideHeadless = browser_options.show;
      } else if (browser_options?.headless !== undefined) {
        overrideHeadless = !browser_options.headless;
      } else if (show_browser !== undefined) {
        overrideHeadless = show_browser;
      }

      return await withRuntimeConfig(effectiveConfig, async () => {
        // Get or create session (with headless override to handle mode changes)
        const session = await this.sessionManager.getOrCreateSession(
          session_id,
          resolvedNotebookUrl,
          overrideHeadless,
          this.ownerId
        );

        // Progress: Asking question
        await sendProgress?.("Asking question to NotebookLM...", 2, 5);

        // Ask the question (pass progress callback)
        // Asking and citation extraction share one per-session lock so a
        // concurrent follow-up cannot disturb the citation panel.
        const citationResult = await session.askAndExtractCitations(
          question,
          source_format,
          sendProgress,
          signal
        );
        const baseAnswer = citationResult.formattedAnswer;

        const trimmed = baseAnswer.trimEnd();
        const withReminder = followUpReminderEnabled()
          ? `${trimmed}${FOLLOW_UP_REMINDER}`
          : trimmed;
        const answer = applyAiMarker(withReminder);

        // Get session info
        const sessionInfo = session.getInfo();

        const result: AskQuestionResult = {
          status: "success",
          question,
          answer,
          session_id: session.sessionId,
          notebook_url: session.notebookUrl,
          session_info: {
            age_seconds: sessionInfo.age_seconds,
            message_count: sessionInfo.message_count,
            last_activity: sessionInfo.last_activity,
          },
          _provenance: PROVENANCE,
          source_format,
          ...(citationResult.citations.length > 0 && { sources: citationResult.citations }),
        };

        // Progress: Complete
        await sendProgress?.("Question answered successfully!", 5, 5);

        log.success(`✅ [TOOL] ask_question completed successfully`);
        return {
          success: true,
          data: result,
        };
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Special handling for rate limit errors
      if (error instanceof RateLimitError || errorMessage.toLowerCase().includes("rate limit")) {
        log.error(`🚫 [TOOL] Rate limit detected`);
        return {
          success: false,
          error: "NotebookLM reported a rate or quota limit. Limits vary by account and plan.",
        };
      }

      log.error(`❌ [TOOL] ask_question failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle list_sessions tool
   */
  async handleListSessions(): Promise<
    ToolResult<{
      active_sessions: number;
      max_sessions: number;
      session_timeout: number;
      oldest_session_seconds: number;
      total_messages: number;
      sessions: Array<{
        id: string;
        created_at: number;
        last_activity: number;
        age_seconds: number;
        inactive_seconds: number;
        message_count: number;
        notebook_url: string;
      }>;
    }>
  > {
    log.info(`🔧 [TOOL] list_sessions called`);

    try {
      const stats = this.sessionManager.getStats(this.ownerId);
      const sessions = this.sessionManager.getAllSessionsInfo(this.ownerId);

      const result = {
        active_sessions: stats.active_sessions,
        max_sessions: stats.max_sessions,
        session_timeout: stats.session_timeout,
        oldest_session_seconds: stats.oldest_session_seconds,
        total_messages: stats.total_messages,
        sessions: sessions.map((info) => ({
          id: info.id,
          created_at: info.created_at,
          last_activity: info.last_activity,
          age_seconds: info.age_seconds,
          inactive_seconds: info.inactive_seconds,
          message_count: info.message_count,
          notebook_url: info.notebook_url,
        })),
      };

      log.success(`✅ [TOOL] list_sessions completed (${result.active_sessions} sessions)`);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_sessions failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle close_session tool
   */
  async handleCloseSession(args: {
    session_id: string;
  }): Promise<ToolResult<{ status: string; message: string; session_id: string }>> {
    const { session_id } = args;

    log.info(`🔧 [TOOL] close_session called`);
    log.info(`  Session ID hash: ${hashLogValue(session_id)}`);

    try {
      const closed = await this.sessionManager.closeSession(session_id, this.ownerId);

      if (closed) {
        log.success(`✅ [TOOL] close_session completed`);
        return {
          success: true,
          data: {
            status: "success",
            message: `Session ${session_id} closed successfully`,
            session_id,
          },
        };
      } else {
        log.warning(`⚠️  [TOOL] Session ${hashLogValue(session_id)} not found`);
        return {
          success: false,
          error: `Session ${session_id} not found`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] close_session failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle reset_session tool
   */
  async handleResetSession(
    args: {
      session_id: string;
    },
    signal?: AbortSignal
  ): Promise<ToolResult<{ status: string; message: string; session_id: string }>> {
    const { session_id } = args;

    log.info(`🔧 [TOOL] reset_session called`);
    log.info(`  Session ID hash: ${hashLogValue(session_id)}`);

    try {
      const session = this.sessionManager.getSession(session_id, this.ownerId);

      if (!session) {
        log.warning(`⚠️  [TOOL] Session ${hashLogValue(session_id)} not found`);
        return {
          success: false,
          error: `Session ${session_id} not found`,
        };
      }

      await session.reset(signal);

      log.success(`✅ [TOOL] reset_session completed`);
      return {
        success: true,
        data: {
          status: "success",
          message: `Session ${session_id} reset successfully`,
          session_id,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] reset_session failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_health tool
   */
  async handleGetHealth(): Promise<
    ToolResult<{
      status: string;
      auth_state_present: boolean;
      authenticated: null;
      authentication_check: string;
      notebook_url: string;
      active_notebook_id: string | null;
      active_notebook_name: string | null;
      total_notebooks: number;
      active_sessions: number;
      max_sessions: number;
      session_timeout: number;
      total_messages: number;
      headless: boolean;
      auto_login_enabled: boolean;
      stealth_enabled: boolean;
      troubleshooting_tip?: string;
    }>
  > {
    log.info(`🔧 [TOOL] get_health called`);

    try {
      // A saved storage-state file is only a portable cookie backup. Its
      // presence (or age) cannot prove whether Google currently accepts the
      // session, so get_health deliberately avoids claiming a live result.
      const authStatePresent = await this.authManager.hasSavedState();

      // Get session stats
      const stats = this.sessionManager.getStats(this.ownerId);

      // Resolve current notebook from the library — `CONFIG.notebookUrl` is a
      // legacy field (v1) that's no longer set in v2's library-driven flow.
      const active = this.library.getActiveNotebook();
      const notebookUrl = active?.url || CONFIG.notebookUrl || "not configured";

      const result = {
        status: "ok",
        auth_state_present: authStatePresent,
        authenticated: null,
        authentication_check: "Authentication is verified when opening NotebookLM",
        notebook_url: notebookUrl,
        active_notebook_id: active?.id ?? null,
        active_notebook_name: active?.name ?? null,
        total_notebooks: this.library.getStats().total_notebooks,
        active_sessions: stats.active_sessions,
        max_sessions: stats.max_sessions,
        session_timeout: stats.session_timeout,
        total_messages: stats.total_messages,
        headless: CONFIG.headless,
        auto_login_enabled: CONFIG.autoLoginEnabled,
        stealth_enabled: CONFIG.stealthEnabled,
        // Missing state may still be backed by the persistent Chrome profile.
        // Do not direct agents to destructive cleanup based on this signal.
        ...(!authStatePresent && {
          troubleshooting_tip:
            "No readable authentication backup was found. Open NotebookLM to verify the " +
            "persistent profile; run setup_auth only if Google requests sign-in.",
        }),
      };

      log.success(`✅ [TOOL] get_health completed`);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_health failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle setup_auth tool
   *
   * Opens a browser window for manual login with live progress updates.
   * The operation waits synchronously for login completion (up to 10 minutes).
   */
  async handleSetupAuth(
    args: {
      show_browser?: boolean;
      browser_options?: BrowserOptions;
    },
    sendProgress?: ProgressCallback,
    signal?: AbortSignal
  ): Promise<
    ToolResult<{
      status: string;
      message: string;
      authenticated: boolean;
      duration_seconds?: number;
    }>
  > {
    const { show_browser, browser_options } = args;

    // CRITICAL: Send immediate progress to reset timeout from the very start
    await sendProgress?.("Initializing authentication setup...", 0, 10);

    log.info(`🔧 [TOOL] setup_auth called`);
    if (show_browser !== undefined) {
      log.info(`  Show browser: ${show_browser}`);
    }

    const startTime = Date.now();

    const effectiveConfig = applyBrowserOptions(browser_options, show_browser ?? true);
    const showBrowser = !effectiveConfig.headless;

    return await withRuntimeConfig(effectiveConfig, async () => {
      try {
        // Progress: Starting
        await sendProgress?.("Preparing authentication browser...", 1, 10);

        const success = await this.sessionManager.runWithClosedBrowserContext(async () => {
          log.info(`  🌐 Opening browser for interactive login...`);

          // Progress: Opening browser
          await sendProgress?.("Opening browser window...", 2, 10);

          // Perform setup with progress updates (uses CONFIG internally)
          return await this.authManager.performSetup(sendProgress, showBrowser, signal);
        });

        const durationSeconds = (Date.now() - startTime) / 1000;

        if (success) {
          // Progress: Complete
          await sendProgress?.("Authentication saved successfully!", 10, 10);

          log.success(`✅ [TOOL] setup_auth completed (${durationSeconds.toFixed(1)}s)`);
          return {
            success: true,
            data: {
              status: "authenticated",
              message: "Successfully authenticated and saved browser state",
              authenticated: true,
              duration_seconds: durationSeconds,
            },
          };
        } else {
          log.error(`❌ [TOOL] setup_auth failed (${durationSeconds.toFixed(1)}s)`);
          return {
            success: false,
            error: "Authentication failed or was cancelled",
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const durationSeconds = (Date.now() - startTime) / 1000;
        log.error(`❌ [TOOL] setup_auth failed: ${errorMessage} (${durationSeconds.toFixed(1)}s)`);
        return {
          success: false,
          error: errorMessage,
        };
      }
    });
  }

  /**
   * Handle re_auth tool
   *
   * Performs a complete re-authentication:
   * 1. Closes all active browser sessions
   * 2. Deletes all saved authentication data (cookies, Chrome profile)
   * 3. Opens browser for fresh Google login
   *
   * Use for switching Google accounts or recovering from rate limits.
   */
  async handleReAuth(
    args: {
      show_browser?: boolean;
      browser_options?: BrowserOptions;
    },
    sendProgress?: ProgressCallback,
    signal?: AbortSignal
  ): Promise<
    ToolResult<{
      status: string;
      message: string;
      authenticated: boolean;
      duration_seconds?: number;
    }>
  > {
    const { show_browser, browser_options } = args;

    await sendProgress?.("Preparing re-authentication...", 0, 12);
    log.info(`🔧 [TOOL] re_auth called`);
    if (show_browser !== undefined) {
      log.info(`  Show browser: ${show_browser}`);
    }

    const startTime = Date.now();

    const effectiveConfig = applyBrowserOptions(browser_options, show_browser ?? true);
    const showBrowser = !effectiveConfig.headless;

    return await withRuntimeConfig(effectiveConfig, async () => {
      try {
        // 1. Close all active sessions
        await sendProgress?.("Closing all active sessions...", 1, 12);
        log.info("  🛑 Closing all sessions...");
        const success = await this.sessionManager.runWithClosedBrowserContext(async () => {
          log.success("  ✅ All sessions closed");

          // 2. Clear all auth data
          await sendProgress?.("Clearing authentication data...", 2, 12);
          log.info("  🗑️  Clearing all auth data...");
          await this.authManager.clearAllAuthData();
          log.success("  ✅ Auth data cleared");

          // 3. Perform fresh setup
          await sendProgress?.("Starting fresh authentication...", 3, 12);
          log.info("  🌐 Starting fresh authentication setup...");
          return await this.authManager.performSetup(sendProgress, showBrowser, signal);
        });

        const durationSeconds = (Date.now() - startTime) / 1000;

        if (success) {
          await sendProgress?.("Re-authentication complete!", 12, 12);
          log.success(`✅ [TOOL] re_auth completed (${durationSeconds.toFixed(1)}s)`);
          return {
            success: true,
            data: {
              status: "authenticated",
              message:
                "Successfully re-authenticated with new account. All previous sessions have been closed.",
              authenticated: true,
              duration_seconds: durationSeconds,
            },
          };
        } else {
          log.error(`❌ [TOOL] re_auth failed (${durationSeconds.toFixed(1)}s)`);
          return {
            success: false,
            error: "Re-authentication failed or was cancelled",
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const durationSeconds = (Date.now() - startTime) / 1000;
        log.error(`❌ [TOOL] re_auth failed: ${errorMessage} (${durationSeconds.toFixed(1)}s)`);
        return {
          success: false,
          error: errorMessage,
        };
      }
    });
  }

  /**
   * Handle add_notebook tool
   */
  async handleAddNotebook(
    args: AddNotebookInput
  ): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] add_notebook called`);
    log.info(`  Notebook name characters: ${args.name.length}`);

    try {
      const notebook = this.library.addNotebook(args);
      log.success(`✅ [TOOL] add_notebook completed`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] add_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle list_notebooks tool
   */
  async handleListNotebooks(): Promise<ToolResult<{ notebooks: NotebookEntry[] }>> {
    log.info(`🔧 [TOOL] list_notebooks called`);

    try {
      const notebooks = this.library.listNotebooks();
      log.success(`✅ [TOOL] list_notebooks completed (${notebooks.length} notebooks)`);
      return {
        success: true,
        data: { notebooks },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_notebooks failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle list_account_notebooks tool
   */
  async handleListAccountNotebooks(
    signal?: AbortSignal
  ): Promise<ToolResult<{ notebooks: AccountNotebookSummary[] }>> {
    log.info(`🔧 [TOOL] list_account_notebooks called`);

    try {
      const notebooks = await this.sessionManager.listAccountNotebooks(signal);
      log.success(`✅ [TOOL] list_account_notebooks completed (${notebooks.length} notebooks)`);
      return {
        success: true,
        data: { notebooks },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_account_notebooks failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async handleImportAccountNotebook(
    args: {
      google_notebook_id: string;
      description?: string;
      topics?: string[];
      content_types?: string[];
      use_cases?: string[];
      tags?: string[];
    },
    signal?: AbortSignal
  ): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] import_account_notebook called`);
    try {
      const accountNotebooks = await this.sessionManager.listAccountNotebooks(signal);
      const accountNotebook = accountNotebooks.find(
        (notebook) => notebook.id === args.google_notebook_id
      );
      if (!accountNotebook) {
        return { success: false, error: "Notebook was not found in the signed-in Google account" };
      }
      const notebook = this.library.importAccountNotebook(accountNotebook, {
        description: args.description,
        topics: args.topics,
        content_types: args.content_types,
        use_cases: args.use_cases,
        tags: args.tags,
      });
      return { success: true, data: { notebook } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] import_account_notebook failed: ${message}`);
      return { success: false, error: message };
    }
  }

  async handleSyncLibrary(
    args: { apply?: boolean },
    signal?: AbortSignal
  ): Promise<ToolResult<{ sync: LibrarySyncResult }>> {
    log.info(`🔧 [TOOL] sync_library called (apply=${args.apply === true})`);
    try {
      const accountNotebooks = await this.sessionManager.listAccountNotebooks(signal);
      const sync = this.library.syncAccountNotebooks(accountNotebooks, args.apply === true);
      return { success: true, data: { sync } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] sync_library failed: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Handle get_notebook tool
   */
  async handleGetNotebook(args: { id: string }): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] get_notebook called`);
    log.info(`  Notebook ID hash: ${hashLogValue(args.id)}`);

    try {
      const notebook = this.library.getNotebook(args.id);
      if (!notebook) {
        log.warning(`⚠️  [TOOL] Notebook not found: ${hashLogValue(args.id)}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }

      log.success(`✅ [TOOL] get_notebook completed`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle select_notebook tool
   */
  async handleSelectNotebook(args: {
    id: string;
  }): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] select_notebook called`);
    log.info(`  Notebook ID hash: ${hashLogValue(args.id)}`);

    try {
      const notebook = this.library.selectNotebook(args.id);
      log.success(`✅ [TOOL] select_notebook completed`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] select_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle update_notebook tool
   */
  async handleUpdateNotebook(
    args: UpdateNotebookInput
  ): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] update_notebook called`);
    log.info(`  Notebook ID hash: ${hashLogValue(args.id)}`);

    try {
      const notebook = this.library.updateNotebook(args);
      log.success(`✅ [TOOL] update_notebook completed`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] update_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle remove_notebook tool
   */
  async handleRemoveNotebook(args: {
    id: string;
  }): Promise<ToolResult<{ removed: boolean; closed_sessions: number }>> {
    log.info(`🔧 [TOOL] remove_notebook called`);
    log.info(`  Notebook ID hash: ${hashLogValue(args.id)}`);

    try {
      const notebook = this.library.getNotebook(args.id);
      if (!notebook) {
        log.warning(`⚠️  [TOOL] Notebook not found: ${hashLogValue(args.id)}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }

      const removed = this.library.removeNotebook(args.id);
      if (removed) {
        const closedSessions = await this.sessionManager.closeSessionsForNotebook(
          notebook.url,
          this.ownerId
        );
        log.success(`✅ [TOOL] remove_notebook completed`);
        return {
          success: true,
          data: { removed: true, closed_sessions: closedSessions },
        };
      } else {
        log.warning(`⚠️  [TOOL] Notebook not found: ${hashLogValue(args.id)}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] remove_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle search_notebooks tool
   */
  async handleSearchNotebooks(args: {
    query: string;
  }): Promise<ToolResult<{ notebooks: NotebookEntry[] }>> {
    log.info(`🔧 [TOOL] search_notebooks called`);
    log.info(`  Search query characters: ${args.query.length}`);

    try {
      const notebooks = this.library.searchNotebooks(args.query);
      log.success(`✅ [TOOL] search_notebooks completed (${notebooks.length} results)`);
      return {
        success: true,
        data: { notebooks },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] search_notebooks failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_library_stats tool
   */
  async handleGetLibraryStats(): Promise<ToolResult<LibraryStats>> {
    log.info(`🔧 [TOOL] get_library_stats called`);

    try {
      const stats = this.library.getStats();
      log.success(`✅ [TOOL] get_library_stats completed`);
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_library_stats failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle cleanup_data tool
   *
   * Constrained, token-bound cleanup of NOTEBOOKLM_DATA_DIR only.
   */
  async handleCleanupData(args: {
    confirm: boolean;
    preserve_library?: boolean;
    preview_token?: string;
  }): Promise<
    ToolResult<{
      status: string;
      mode: string;
      preview?: {
        preview_token: string;
        expires_at: string;
        path_digest: string;
        categories: Array<{
          name: string;
          description: string;
          paths: string[];
          totalBytes: number;
          optional: boolean;
        }>;
        totalPaths: number;
        totalSizeBytes: number;
      };
      result?: {
        deletedPaths: string[];
        failedPaths: string[];
        totalSizeBytes: number;
        categorySummary: Record<string, { count: number; bytes: number }>;
      };
    }>
  > {
    const { confirm, preserve_library = false, preview_token } = args;

    log.info(`🔧 [TOOL] cleanup_data called`);
    log.info(`  Confirm: ${confirm}`);
    log.info(`  Preserve Library: ${preserve_library}`);

    try {
      const mode = "data";

      if (!confirm) {
        const preview = await this.sessionManager.runWithCleanupSafeContext(() =>
          this.cleanupManager.createPreview(preserve_library)
        );

        log.info(
          `  Found ${preview.totalPaths.length} owned items (${this.cleanupManager.formatBytes(preview.totalSizeBytes)})`
        );

        return {
          success: true,
          data: {
            status: "preview",
            mode,
            preview: {
              preview_token: preview.previewToken,
              expires_at: preview.expiresAt,
              path_digest: preview.pathDigest,
              categories: preview.categories,
              totalPaths: preview.totalPaths.length,
              totalSizeBytes: preview.totalSizeBytes,
            },
          },
        };
      } else {
        if (!preview_token) {
          return {
            success: false,
            error: "preview_token is required when confirm=true; generate a fresh preview first",
          };
        }

        const result = await this.sessionManager.runWithCleanupSafeContext(() =>
          this.cleanupManager.performCleanup(preview_token)
        );

        if (result.success) {
          log.success(
            `✅ [TOOL] cleanup_data completed - deleted ${result.deletedPaths.length} items`
          );
        } else {
          log.warning(`⚠️  [TOOL] cleanup_data completed with ${result.failedPaths.length} errors`);
        }

        return {
          success: result.success,
          data: {
            status: result.success ? "completed" : "partial",
            mode,
            result: {
              deletedPaths: result.deletedPaths,
              failedPaths: result.failedPaths,
              totalSizeBytes: result.totalSizeBytes,
              categorySummary: result.categorySummary,
            },
          },
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] cleanup_data failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Resolve a notebook URL the same way `handleAskQuestion` does. Used by the
   * new source/audio tools so we don't duplicate the lookup logic.
   */
  private async resolveNotebookUrl(
    notebookId?: string,
    notebookUrl?: string
  ): Promise<string | undefined> {
    if (notebookUrl) return notebookUrl;
    if (notebookId) {
      const nb = this.library.getNotebook(notebookId);
      if (!nb) throw new Error(`Notebook not found in library: ${notebookId}`);
      return nb.url;
    }
    const active = this.library.getActiveNotebook();
    return active?.url;
  }

  /**
   * Handle add_source tool (issue #25).
   */
  async handleAddSource(
    args: {
      type: "url" | "text" | "youtube";
      content: string;
      title?: string;
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
    },
    signal?: AbortSignal
  ): Promise<ToolResult<{ result: AddSourceResult }>> {
    log.info(`🔧 [TOOL] add_source called (type=${args.type})`);
    const effectiveConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    return await withRuntimeConfig(effectiveConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless,
          this.ownerId
        );
        const result = await session.addSource(
          {
            type: args.type,
            content: args.content,
            title: args.title,
          },
          signal
        );
        return { success: result.success, data: { result } };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] add_source failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  async handleListSources(
    args: {
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
    },
    signal?: AbortSignal
  ): Promise<ToolResult<{ sources: SourceSummary[]; count: number }>> {
    log.info(`🔧 [TOOL] list_sources called`);
    const effectiveConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    return await withRuntimeConfig(effectiveConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless,
          this.ownerId
        );
        const sources = await session.listSources(signal);
        return { success: true, data: { sources, count: sources.length } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    });
  }

  async handleGetSource(
    args: {
      source_id?: string;
      name?: string;
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
    },
    signal?: AbortSignal
  ): Promise<ToolResult<{ source: SourceSummary }>> {
    log.info(`🔧 [TOOL] get_source called`);
    const effectiveConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    return await withRuntimeConfig(effectiveConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless,
          this.ownerId
        );
        const source = await session.getSource(
          { sourceId: args.source_id, name: args.name },
          signal
        );
        if (!source) return { success: false, error: "Source not found" };
        return { success: true, data: { source } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    });
  }

  async handleBatchAddSources(
    args: {
      sources: AddSourceInput[];
      stop_on_error?: boolean;
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
    },
    signal?: AbortSignal
  ): Promise<ToolResult<{ results: AddSourceResult[]; added: number; failed: number }>> {
    log.info(`🔧 [TOOL] batch_add_sources called (${args.sources.length} sources)`);
    const effectiveConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    return await withRuntimeConfig(effectiveConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless,
          this.ownerId
        );
        const results: AddSourceResult[] = [];
        for (const source of args.sources) {
          const result = await session.addSource(source, signal);
          results.push(result);
          if (!result.success && args.stop_on_error !== false) break;
        }
        const added = results.filter((result) => result.success).length;
        return {
          success: added === results.length,
          data: { results, added, failed: results.length - added },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    });
  }

  async handleGenerateArtifact(
    args: {
      type: ArtifactType;
      custom_prompt?: string;
      wait_for_completion?: boolean;
      timeout_ms?: number;
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
    },
    signal?: AbortSignal
  ): Promise<ToolResult<{ job: ArtifactJob }>> {
    const effectiveConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    return await withRuntimeConfig(effectiveConfig, async () => {
      const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
      if (!url) throw new Error("No notebook selected. Provide notebook_id or notebook_url.");
      const job = this.artifactStore.create(ARTIFACT_OWNER_ID, url, args.type);
      try {
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless,
          this.ownerId
        );
        const result = await session.generateAudio(
          {
            customPrompt: args.custom_prompt,
            waitForCompletion: args.wait_for_completion,
            timeoutMs: args.timeout_ms,
          },
          signal
        );
        const status =
          result.status === "ready"
            ? "ready"
            : result.status === "error"
              ? "error"
              : result.status === "started"
                ? "started"
                : "in_progress";
        const updated = this.artifactStore.update(job.job_id, ARTIFACT_OWNER_ID, {
          status,
          artifact_id: status === "ready" ? `audio-overview:${this.notebookKey(url)}` : null,
          message: result.message,
        })!;
        return { success: status !== "error", data: { job: updated } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.artifactStore.update(job.job_id, ARTIFACT_OWNER_ID, { status: "error", message });
        return { success: false, error: message };
      }
    });
  }

  async handleListArtifacts(args: {
    notebook_id?: string;
    notebook_url?: string;
  }): Promise<ToolResult<{ artifacts: ArtifactJob[] }>> {
    try {
      const hasTarget = Boolean(args.notebook_id || args.notebook_url);
      const url = hasTarget
        ? await this.resolveNotebookUrl(args.notebook_id, args.notebook_url)
        : undefined;
      return {
        success: true,
        data: { artifacts: this.artifactStore.list(ARTIFACT_OWNER_ID, url) },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async handleGetArtifactStatus(
    args: { job_id: string; show_browser?: boolean },
    signal?: AbortSignal
  ): Promise<ToolResult<{ job: ArtifactJob }>> {
    const job = this.artifactStore.get(args.job_id, ARTIFACT_OWNER_ID);
    if (!job) return { success: false, error: "Artifact job not found" };
    const effectiveConfig = applyBrowserOptions(undefined, args.show_browser);
    return await withRuntimeConfig(effectiveConfig, async () => {
      try {
        const session = await this.sessionManager.getOrCreateSession(
          undefined,
          job.notebook_url,
          args.show_browser,
          this.ownerId
        );
        const result = await session.getAudioStatus(signal);
        const status = result.status === "not_started" ? "error" : result.status;
        const updated = this.artifactStore.update(job.job_id, ARTIFACT_OWNER_ID, {
          status,
          artifact_id:
            status === "ready"
              ? (job.artifact_id ?? `audio-overview:${this.notebookKey(job.notebook_url)}`)
              : job.artifact_id,
          message: result.message,
        })!;
        return { success: status !== "error", data: { job: updated } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    });
  }

  async handleDownloadArtifact(
    args: { job_id: string; destination_dir: string; show_browser?: boolean },
    signal?: AbortSignal
  ): Promise<ToolResult<{ job: ArtifactJob; result: DownloadAudioResult }>> {
    const job = this.artifactStore.get(args.job_id, ARTIFACT_OWNER_ID);
    if (!job) return { success: false, error: "Artifact job not found" };
    try {
      resolveOutputDirectory(args.destination_dir);
      const session = await this.sessionManager.getOrCreateSession(
        undefined,
        job.notebook_url,
        args.show_browser,
        this.ownerId
      );
      const result = await session.downloadAudio(args.destination_dir, signal);
      const updated = this.artifactStore.update(job.job_id, ARTIFACT_OWNER_ID, {
        ...(result.success && { status: "ready" as const }),
        ...(result.filePath && { file_path: result.filePath }),
        message: result.message,
      })!;
      return { success: result.success, data: { job: updated, result } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private notebookKey(url: string): string {
    return url.match(/\/notebook\/([^/?#]+)/)?.[1] ?? hashLogValue(url);
  }

  /**
   * Handle generate_audio tool (issue #11).
   */
  async handleGenerateAudio(
    args: {
      custom_prompt?: string;
      timeout_ms?: number;
      wait_for_completion?: boolean;
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
    },
    signal?: AbortSignal
  ): Promise<ToolResult<{ result: AudioGenerationResult }>> {
    log.info(`🔧 [TOOL] generate_audio called`);
    const effectiveConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    return await withRuntimeConfig(effectiveConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless,
          this.ownerId
        );
        const result = await session.generateAudio(
          {
            customPrompt: args.custom_prompt,
            timeoutMs: args.timeout_ms,
            waitForCompletion: args.wait_for_completion ?? false,
          },
          signal
        );
        // `started` and `in_progress` count as success — the generation is on
        // its way; the caller polls `get_audio_status` for completion.
        const ok =
          result.status === "ready" ||
          result.status === "started" ||
          result.status === "in_progress";
        return { success: ok, data: { result } };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] generate_audio failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Handle get_audio_status tool — non-blocking poll for Audio Overview state.
   */
  async handleGetAudioStatus(
    args: {
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
    },
    signal?: AbortSignal
  ): Promise<ToolResult<{ result: AudioGenerationResult }>> {
    log.info(`🔧 [TOOL] get_audio_status called`);
    const effectiveConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    return await withRuntimeConfig(effectiveConfig, async () => {
      try {
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless,
          this.ownerId
        );
        const result = await session.getAudioStatus(signal);
        return { success: true, data: { result } };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] get_audio_status failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Handle download_audio tool (issue #11).
   */
  async handleDownloadAudio(
    args: {
      destination_dir: string;
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
    },
    signal?: AbortSignal
  ): Promise<ToolResult<{ result: DownloadAudioResult }>> {
    log.info(`🔧 [TOOL] download_audio called`);
    const effectiveConfig = applyBrowserOptions(undefined, args.show_browser);
    const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
    return await withRuntimeConfig(effectiveConfig, async () => {
      try {
        resolveOutputDirectory(args.destination_dir);
        const url = await this.resolveNotebookUrl(args.notebook_id, args.notebook_url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless,
          this.ownerId
        );
        const result = await session.downloadAudio(args.destination_dir, signal);
        return { success: result.success, data: { result } };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] download_audio failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Cleanup all resources (called on server shutdown)
   */
  async cleanup(): Promise<void> {
    log.info(`🧹 Cleaning up tool handlers...`);
    await this.sessionManager.shutdown();
    log.success(`✅ Tool handlers cleanup complete`);
  }
}
