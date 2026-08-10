/**
 * Session Manager
 *
 * Manages multiple parallel browser sessions for NotebookLM API
 *
 * Features:
 * - Session lifecycle management
 * - Auto-cleanup of inactive sessions
 * - Resource limits (max concurrent sessions)
 * - Shared PERSISTENT browser fingerprint (ONE context for all sessions)
 *
 * Based on the Python implementation from session_manager.py
 */

import type { AuthManager } from "../auth/auth-manager.js";
import { BrowserSession } from "./browser-session.js";
import { SharedContextManager } from "./shared-context-manager.js";
import { CONFIG, getRuntimeConfig } from "../config.js";
import { hashLogValue, log } from "../utils/logger.js";
import type { SessionInfo } from "../types.js";
import { randomUUID } from "node:crypto";
import { normalizeNotebookUrl } from "../notebooklm/url.js";
import { Selectors, joinAlt } from "../notebooklm/selectors.js";
import { UiChangedError } from "../errors.js";
import { runWithOperationBoundary } from "../utils/operation.js";

const NOTEBOOKLM_HOME_URL = "https://notebook.google.com/";

export interface AccountNotebookSummary {
  /** Real Google notebook id, read from the card's href. */
  id: string;
  name: string;
  url: string;
  /** Raw "date · N sources" text as shown on the card, locale-dependent. */
  lastModified: string;
  sourceCount: number | null;
}

interface OwnedBrowserSession {
  ownerId: string;
  session: BrowserSession;
}

const LOCAL_OWNER_ID = "local-stdio-client";

export class SessionManager {
  private authManager: AuthManager;
  private sharedContextManager: SharedContextManager;
  private sessions: Map<string, OwnedBrowserSession> = new Map();
  private maxSessions: number;
  private sessionTimeout: number;
  private cleanupInterval?: NodeJS.Timeout;
  private sessionMutationTail: Promise<void> = Promise.resolve();

  constructor(authManager: AuthManager) {
    this.authManager = authManager;
    this.sharedContextManager = new SharedContextManager(authManager);
    this.maxSessions = CONFIG.maxSessions;
    this.sessionTimeout = CONFIG.sessionTimeout;

    log.info("🎯 SessionManager initialized");
    log.info(`  Max sessions: ${this.maxSessions}`);
    log.info(
      `  Timeout: ${this.sessionTimeout}s (${Math.floor(this.sessionTimeout / 60)} minutes)`
    );

    const cleanupIntervalSeconds = Math.max(60, Math.min(Math.floor(this.sessionTimeout / 2), 300));
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveSessions().catch((error) => {
        log.warning(`⚠️  Error during automatic session cleanup: ${error}`);
      });
    }, cleanupIntervalSeconds * 1000);
    this.cleanupInterval.unref();
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return randomUUID();
  }

  private async runSessionMutationExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.sessionMutationTail;

    this.sessionMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Get existing session or create a new one
   *
   * @param sessionId Optional session ID to reuse existing session
   * @param notebookUrl Notebook URL for the session
   * @param overrideHeadless Optional override for headless mode (true = show browser)
   */
  async getOrCreateSession(
    sessionId?: string,
    notebookUrl?: string,
    overrideHeadless?: boolean,
    ownerId = LOCAL_OWNER_ID
  ): Promise<BrowserSession> {
    return await this.runSessionMutationExclusive(() =>
      this.getOrCreateSessionUnlocked(sessionId, notebookUrl, overrideHeadless, ownerId)
    );
  }

  private async getOrCreateSessionUnlocked(
    sessionId?: string,
    notebookUrl?: string,
    overrideHeadless?: boolean,
    ownerId = LOCAL_OWNER_ID
  ): Promise<BrowserSession> {
    // Determine target notebook URL
    const requestedUrl = (notebookUrl || CONFIG.notebookUrl || "").trim();
    if (!requestedUrl) {
      throw new Error("Notebook URL is required to create a session");
    }
    const targetUrl = normalizeNotebookUrl(requestedUrl);

    // Generate ID if not provided
    if (!sessionId) {
      sessionId = this.generateSessionId();
      log.info(`🆕 Auto-generated session ID hash: ${hashLogValue(sessionId)}`);
    }

    // Check if browser visibility mode needs to change
    if (overrideHeadless !== undefined) {
      if (this.sharedContextManager.needsHeadlessModeChange(overrideHeadless)) {
        if (this.sessions.size > 0) {
          throw new Error(
            "Browser visibility cannot change while sessions are active. " +
              "Close active sessions first or start the server with the desired HEADLESS setting."
          );
        }
        log.warning(`🔄 Browser visibility changed - recreating idle browser context...`);
        const currentMode = this.sharedContextManager.getCurrentHeadlessMode();
        log.info(
          `  Switching from ${currentMode ? "HEADLESS" : "VISIBLE"} to ${overrideHeadless ? "VISIBLE" : "HEADLESS"}`
        );

        await this.closeAllSessionsUnlocked();
        log.success(`  ✅ Browser context will be recreated with new mode`);
      }
    }

    // Return existing session if found
    if (this.sessions.has(sessionId)) {
      const owned = this.sessions.get(sessionId)!;
      if (owned.ownerId !== ownerId) {
        throw new Error("Session not found");
      }
      const session = owned.session;
      if (session.notebookUrl !== targetUrl) {
        log.warning(`♻️  Replacing session ${hashLogValue(sessionId)} with new notebook URL`);
        await session.close();
        this.sessions.delete(sessionId);
      } else {
        session.updateActivity();
        log.success(`♻️  Reusing existing session ${hashLogValue(sessionId)}`);
        return session;
      }
    }

    // Check if we need to free up space
    if (this.sessions.size >= this.maxSessions) {
      log.warning(`⚠️  Max sessions (${this.maxSessions}) reached, cleaning up...`);
      const freed = await this.cleanupOldestInactiveSession(ownerId);
      if (!freed) {
        throw new Error(
          `Max sessions (${this.maxSessions}) reached and no inactive sessions to clean up`
        );
      }
    }

    // Create new session
    log.info(`🆕 Creating new session ${hashLogValue(sessionId)}...`);
    if (overrideHeadless !== undefined) {
      log.info(`  Show browser: ${overrideHeadless}`);
    }
    try {
      // Ensure the shared context exists (ONE fingerprint for all sessions!)
      await this.sharedContextManager.getOrCreateContext(overrideHeadless);

      // Create and initialize session
      const session = new BrowserSession(
        sessionId,
        this.sharedContextManager,
        this.authManager,
        targetUrl
      );
      await session.init();

      this.sessions.set(sessionId, { ownerId, session });
      log.success(
        `✅ Session ${hashLogValue(sessionId)} created (${this.sessions.size}/${this.maxSessions} active)`
      );
      return session;
    } catch (error) {
      log.error(`❌ Failed to create session: ${error}`);
      throw error;
    }
  }

  /**
   * Get an existing session by ID
   */
  getSession(sessionId: string, ownerId = LOCAL_OWNER_ID): BrowserSession | null {
    const owned = this.sessions.get(sessionId);
    return owned?.ownerId === ownerId ? owned.session : null;
  }

  /**
   * Close and remove a specific session
   */
  async closeSession(sessionId: string, ownerId = LOCAL_OWNER_ID): Promise<boolean> {
    return await this.runSessionMutationExclusive(() =>
      this.closeSessionUnlocked(sessionId, ownerId)
    );
  }

  private async closeSessionUnlocked(
    sessionId: string,
    ownerId = LOCAL_OWNER_ID
  ): Promise<boolean> {
    const owned = this.sessions.get(sessionId);
    if (!owned || owned.ownerId !== ownerId) {
      log.warning(`⚠️  Session ${hashLogValue(sessionId)} not found`);
      return false;
    }

    const session = owned.session;
    await session.close();
    this.sessions.delete(sessionId);

    log.success(
      `✅ Session ${hashLogValue(sessionId)} closed (${this.sessions.size}/${this.maxSessions} active)`
    );
    return true;
  }

  /**
   * Close all sessions that are using the provided notebook URL
   */
  async closeSessionsForNotebook(url: string, ownerId = LOCAL_OWNER_ID): Promise<number> {
    return await this.runSessionMutationExclusive(() =>
      this.closeSessionsForNotebookUnlocked(url, ownerId)
    );
  }

  private async closeSessionsForNotebookUnlocked(
    url: string,
    ownerId = LOCAL_OWNER_ID
  ): Promise<number> {
    let closed = 0;

    for (const [sessionId, owned] of Array.from(this.sessions.entries())) {
      if (owned.ownerId === ownerId && owned.session.notebookUrl === url) {
        try {
          await owned.session.close();
        } catch (error) {
          log.warning(`  ⚠️  Error closing ${hashLogValue(sessionId)}: ${error}`);
        } finally {
          this.sessions.delete(sessionId);
          closed++;
        }
      }
    }

    if (closed > 0) {
      log.warning(
        `🧹 Closed ${closed} session(s) using removed notebook (${this.sessions.size}/${this.maxSessions} active)`
      );
    }

    return closed;
  }

  /**
   * List the notebooks that actually exist in the signed-in Google account,
   * as shown on the NotebookLM home grid. Unlike `NotebookLibrary.listNotebooks()`
   * (a locally curated bookmark list), this reflects reality: every notebook
   * the user created, whether or not it was ever registered with `add_notebook`.
   *
   * Verified live against the real 2026-07 layout: each card is an
   * `<a role="link" class="primary-action-button" href="/notebook/<uuid>">`,
   * whose `aria-labelledby`/`aria-describedby` point at
   * `project-<uuid>-title` / `project-<uuid>-subtitle` spans holding the
   * visible name and the "date · N sources" line. The id comes straight from
   * `href` — no need to click through and read it back from the URL.
   */
  async listAccountNotebooks(signal?: AbortSignal): Promise<AccountNotebookSummary[]> {
    const context = await this.sharedContextManager.getOrCreateContext();
    const page = await context.newPage();
    const timeout = getRuntimeConfig().browserTimeout;
    try {
      return await runWithOperationBoundary(
        "list_account_notebooks",
        async () => {
          await page.goto(NOTEBOOKLM_HOME_URL, { waitUntil: "domcontentloaded", timeout });
          if (/accounts\.google\.com/i.test(page.url())) {
            throw new Error(
              "NotebookLM MCP no está autenticado. Ejecuta setup_auth antes de listar los notebooks de la cuenta."
            );
          }

          // Angular hydrates the grid after domcontentloaded (same class of race
          // already documented for the chat page).
          const cardSelector = Selectors.notebooks.projectCard;
          const homeState = await Promise.any([
            page.waitForSelector(cardSelector, { timeout: 12_000 }).then(() => "cards" as const),
            page
              .locator(joinAlt(Selectors.notebooks.emptyState))
              .first()
              .waitFor({ state: "visible", timeout: 12_000 })
              .then(() => "empty" as const),
          ]).catch(() => null);
          if (homeState === "empty") return [];
          if (homeState !== "cards") {
            const diagnostics = await page
              .evaluate(() => ({
                title: document.title,
                body: document.body.innerText.slice(0, 800),
              }))
              .catch(() => ({ title: "", body: "" }));
            log.warning("  UI_CHANGED: NotebookLM home grid could not be detected");
            log.diagnostic(
              "list_account_notebooks selector diagnostics",
              JSON.stringify({ selector: cardSelector, url: page.url(), ...diagnostics })
            );
            throw new UiChangedError("notebooks.projectCard");
          }

          return await page.$$eval(cardSelector, (anchors) =>
            anchors
              .map((anchor) => {
                const id =
                  (anchor.getAttribute("href") || "").match(/\/notebook\/([^/?#]+)/)?.[1] || "";
                if (!id) return null;
                const name =
                  document.getElementById(`project-${id}-title`)?.textContent?.trim() || "";
                const subtitle =
                  document.getElementById(`project-${id}-subtitle`)?.textContent?.trim() || "";
                const sourceMatch = subtitle.match(
                  /(\d+)\s*(fuentes?|sources?|quellen|fonti|fontes|bronnen|ソース)/i
                );
                return {
                  id,
                  name,
                  url: `https://notebook.google.com/notebook/${id}`,
                  lastModified: subtitle,
                  sourceCount: sourceMatch ? Number(sourceMatch[1]) : null,
                };
              })
              .filter((entry): entry is AccountNotebookSummary => Boolean(entry && entry.name))
          );
        },
        {
          signal,
          timeoutMs: timeout + 15_000,
          onInterrupt: () => page.close().catch(() => undefined),
        }
      );
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Clean up all inactive sessions
   */
  async cleanupInactiveSessions(): Promise<number> {
    return await this.runSessionMutationExclusive(() => this.cleanupInactiveSessionsUnlocked());
  }

  private async cleanupInactiveSessionsUnlocked(): Promise<number> {
    const inactiveSessions: string[] = [];

    for (const [sessionId, owned] of this.sessions.entries()) {
      if (owned.session.isExpired(this.sessionTimeout)) {
        inactiveSessions.push(sessionId);
      }
    }

    if (inactiveSessions.length === 0) {
      return 0;
    }

    log.warning(`🧹 Cleaning up ${inactiveSessions.length} inactive sessions...`);

    let cleaned = 0;

    for (const sessionId of inactiveSessions) {
      const owned = this.sessions.get(sessionId);

      if (!owned || !owned.session.isExpired(this.sessionTimeout)) {
        continue;
      }

      const session = owned.session;

      try {
        const age = (Date.now() - session.createdAt) / 1000;
        const inactive = (Date.now() - session.lastActivity) / 1000;

        log.warning(
          `  🗑️  ${hashLogValue(sessionId)}: age=${age.toFixed(0)}s, inactive=${inactive.toFixed(0)}s, messages=${session.messageCount}`
        );

        await session.close();
        this.sessions.delete(sessionId);
        cleaned++;
      } catch (error) {
        log.warning(`  ⚠️  Error cleaning up ${hashLogValue(sessionId)}: ${error}`);
      }
    }

    log.success(
      `✅ Cleaned up ${cleaned} sessions (${this.sessions.size}/${this.maxSessions} active)`
    );
    return cleaned;
  }

  /**
   * Clean up the oldest session to make space
   */
  private async cleanupOldestInactiveSession(ownerId: string): Promise<boolean> {
    if (this.sessions.size === 0) {
      return false;
    }

    // Find oldest session
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [sessionId, owned] of this.sessions.entries()) {
      if (
        owned.ownerId === ownerId &&
        owned.session.isExpired(this.sessionTimeout) &&
        owned.session.createdAt < oldestTime
      ) {
        oldestTime = owned.session.createdAt;
        oldestId = sessionId;
      }
    }

    if (!oldestId) {
      return false;
    }

    const oldestSession = this.sessions.get(oldestId)!.session;
    const age = (Date.now() - oldestSession.createdAt) / 1000;

    log.warning(`🗑️  Removing oldest session ${hashLogValue(oldestId)} (age: ${age.toFixed(0)}s)`);

    await oldestSession.close();
    this.sessions.delete(oldestId);

    return true;
  }

  /**
   * Close all sessions without disabling periodic cleanup. Used by runtime
   * operations such as re-authentication and browser-mode changes.
   */
  async closeAllSessions(): Promise<void> {
    return await this.runSessionMutationExclusive(() => this.closeAllSessionsUnlocked());
  }

  private async closeAllSessionsUnlocked(): Promise<void> {
    if (this.sessions.size === 0) {
      log.warning("🛑 Closing shared context (no active sessions)...");
      await this.sharedContextManager.closeContext();
      log.success("✅ All sessions closed");
      return;
    }

    log.warning(`🛑 Closing all ${this.sessions.size} sessions...`);

    for (const sessionId of Array.from(this.sessions.keys())) {
      try {
        const session = this.sessions.get(sessionId)!.session;
        await session.close();
        this.sessions.delete(sessionId);
      } catch (error) {
        log.warning(`  ⚠️  Error closing ${hashLogValue(sessionId)}: ${error}`);
      }
    }

    // Close the shared context
    await this.sharedContextManager.closeContext();

    log.success("✅ All sessions closed");
  }

  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    await this.closeAllSessions();
  }

  /**
   * Put browser state into a safe condition for cleanup without terminating
   * another client's live session. The caller must close all sessions first.
   */
  async prepareForCleanup(): Promise<void> {
    let release!: () => void;
    const previous = this.sessionMutationTail;
    this.sessionMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.sessions.size > 0) {
        throw new Error("cleanup_data requires all browser sessions to be closed before deletion");
      }
      await this.sharedContextManager.closeContext();
    } finally {
      release();
    }
  }

  /**
   * Get all sessions info
   */
  getAllSessionsInfo(ownerId = LOCAL_OWNER_ID): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((owned) => owned.ownerId === ownerId)
      .map((owned) => owned.session.getInfo());
  }

  /**
   * Get aggregate stats
   */
  getStats(ownerId = LOCAL_OWNER_ID): {
    active_sessions: number;
    max_sessions: number;
    session_timeout: number;
    oldest_session_seconds: number;
    total_messages: number;
  } {
    const sessionsInfo = this.getAllSessionsInfo(ownerId);

    const totalMessages = sessionsInfo.reduce((sum, info) => sum + info.message_count, 0);
    const oldestSessionSeconds = Math.max(...sessionsInfo.map((info) => info.age_seconds), 0);

    return {
      active_sessions: sessionsInfo.length,
      max_sessions: this.maxSessions,
      session_timeout: this.sessionTimeout,
      oldest_session_seconds: oldestSessionSeconds,
      total_messages: totalMessages,
    };
  }
}
