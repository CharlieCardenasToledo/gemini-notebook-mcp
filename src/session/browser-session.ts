/**
 * Browser Session
 *
 * Represents a single browser session for NotebookLM interactions.
 *
 * Features:
 * - Human-like question typing
 * - Streaming response detection
 * - Auto-login on session expiry
 * - Session activity tracking
 * - Chat history reset
 *
 * Based on the Python implementation from browser_session.py
 */

import type { BrowserContext, Page } from "patchright";
import type { SharedContextManager } from "./shared-context-manager.js";
import type { AuthManager } from "../auth/auth-manager.js";
import { humanType, randomDelay, randomInt } from "../utils/stealth-utils.js";
import {
  waitForStableAnswer,
  snapshotPriorAnswers,
  dismissUnexpectedOverlay,
} from "../notebooklm/chat.js";
import { Selectors, findVisibleSelector, joinAlt } from "../notebooklm/selectors.js";
import {
  extractCitations as extractCitationsFromPage,
  type SourceFormat,
  type ExtractCitationsResult,
} from "../notebooklm/citations.js";
import {
  addSource as addSourceToPage,
  listSources as listSourcesOnPage,
  getSource as getSourceOnPage,
  type AddSourceInput,
  type AddSourceResult,
  type SourceSummary,
} from "../notebooklm/sources.js";
import {
  generateAudioOverview as generateAudioOnPage,
  downloadAudioOverview as downloadAudioOnPage,
  getAudioStatusOnPage,
  type GenerateAudioOptions,
  type AudioGenerationResult,
  type DownloadAudioResult,
} from "../notebooklm/audio.js";
import { getRuntimeConfig } from "../config.js";
import { hashLogValue, log } from "../utils/logger.js";
import type { SessionInfo, ProgressCallback } from "../types.js";
import { RateLimitError, UiChangedError } from "../errors.js";
import {
  runWithOperationBoundary,
  throwIfAborted,
  type OperationBoundaryOptions,
} from "../utils/operation.js";

interface BrowserOperationOptions extends OperationBoundaryOptions {
  retryRecoverable?: boolean;
}

export class BrowserSession {
  public readonly sessionId: string;
  public readonly notebookUrl: string;
  public readonly createdAt: number;
  public lastActivity: number;
  public messageCount: number;

  private context!: BrowserContext;
  private sharedContextManager: SharedContextManager;
  private authManager: AuthManager;
  private page: Page | null = null;
  private initialized: boolean = false;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    sessionId: string,
    sharedContextManager: SharedContextManager,
    authManager: AuthManager,
    notebookUrl: string
  ) {
    this.sessionId = sessionId;
    this.sharedContextManager = sharedContextManager;
    this.authManager = authManager;
    this.notebookUrl = notebookUrl;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.messageCount = 0;

    log.info(`🆕 BrowserSession ${hashLogValue(sessionId)} created`);
  }

  /**
   * Initialize the session by creating a page and navigating to the notebook
   */
  async init(): Promise<void> {
    const config = getRuntimeConfig();
    if (this.initialized) {
      log.warning(`⚠️  Session ${hashLogValue(this.sessionId)} already initialized`);
      return;
    }

    log.info(`🚀 Initializing session ${hashLogValue(this.sessionId)}...`);

    try {
      // Ensure a valid shared context
      this.context = await this.sharedContextManager.getOrCreateContext();

      // Create new page (tab) in the shared context (with auto-recovery)
      try {
        this.page = await this.context.newPage();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          /has been closed|Target .* closed|Browser has been closed|Context .* closed/i.test(msg)
        ) {
          log.warning("  ♻️  Context was closed. Recreating and retrying newPage...");
          this.context = await this.sharedContextManager.getOrCreateContext();
          this.page = await this.context.newPage();
        } else {
          throw e;
        }
      }
      log.success(`  ✅ Created new page`);

      // Navigate to notebook
      log.info(`  🌐 Navigating to configured notebook`);
      await this.page.goto(this.notebookUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.browserTimeout,
      });

      // Wait for page to stabilize
      await randomDelay(2000, 3000);

      // Check if we need to login
      const cookiesAreValid = await this.authManager.validateCookiesExpiry(this.context);
      const isAuthenticated = cookiesAreValid && !this.isAuthenticationPage();

      if (!isAuthenticated) {
        log.warning(`  🔑 Session ${hashLogValue(this.sessionId)} needs authentication`);
        const loginSuccess = await this.ensureAuthenticated();
        if (!loginSuccess) {
          throw new Error("Failed to authenticate session");
        }
      } else {
        log.success(`  ✅ Session already authenticated`);
      }

      // CRITICAL: Restore sessionStorage from saved state
      // This is essential for maintaining Google session state!
      log.info(`  🔄 Restoring sessionStorage...`);
      const sessionData = await this.authManager.loadSessionStorage();
      if (sessionData) {
        const entryCount = Object.keys(sessionData).length;
        if (entryCount > 0) {
          await this.restoreSessionStorage(sessionData, entryCount);
        } else {
          log.info(`  ℹ️  SessionStorage empty (fresh session)`);
        }
      } else {
        log.info(`  ℹ️  No saved sessionStorage found (fresh session)`);
      }

      // Wait for NotebookLM interface to load
      log.info(`  ⏳ Waiting for NotebookLM interface...`);
      await this.waitForNotebookLMReady();

      // Google can rotate authentication cookies during a successful
      // navigation. Refresh the portable backup only after the NotebookLM UI
      // proves that this browser session is genuinely authenticated.
      await this.authManager.saveBrowserState(this.context, this.page);

      this.initialized = true;
      this.updateActivity();
      log.success(`✅ Session ${hashLogValue(this.sessionId)} initialized successfully`);
    } catch (error) {
      log.error(`❌ Failed to initialize session ${hashLogValue(this.sessionId)}: ${error}`);
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      throw error;
    }
  }

  /**
   * Wait for NotebookLM interface to be ready
   *
   * IMPORTANT: Matches Python implementation EXACTLY!
   * - Uses SPECIFIC selectors (textarea.query-box-input)
   * - Checks ONLY for "visible" state (NOT disabled!)
   * - NO placeholder checks (let NotebookLM handle that!)
   *
   * Based on Python _wait_for_ready() from browser_session.py:104-113
   */
  private async waitForNotebookLMReady(): Promise<void> {
    if (!this.page) {
      throw new Error("Page not initialized");
    }

    try {
      log.info("  ⏳ Waiting for a verified chat input...");
      await this.page.waitForSelector(joinAlt(Selectors.chat.queryInput), {
        timeout: 15_000,
        state: "visible",
      });
      log.success("  ✅ Chat input ready!");
    } catch (error) {
      log.diagnostic("chat.queryInput verification failure", String(error));
      throw new UiChangedError("chat.queryInput");
    }
  }

  private isPageClosedSafe(): boolean {
    if (!this.page) return true;
    try {
      if (this.page.isClosed()) return true;
      // Accessing URL should be safe; if page is gone, this may throw.
      void this.page.url();
      return false;
    } catch {
      return true;
    }
  }

  private isAuthenticationPage(): boolean {
    if (!this.page) return false;
    try {
      const url = new URL(this.page.url());
      return url.hostname === "accounts.google.com" || /\/login(?:[/?#]|$)/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  /**
   * Ensure the session is authenticated, perform auto-login if needed
   */
  private async ensureAuthenticated(): Promise<boolean> {
    const config = getRuntimeConfig();
    if (!this.page) {
      throw new Error("Page not initialized");
    }

    log.info(`🔑 Checking authentication for session ${hashLogValue(this.sessionId)}...`);

    // Check cookie validity
    const isValid = await this.authManager.validateCookiesExpiry(this.context);

    if (isValid && !this.isAuthenticationPage()) {
      log.success(`  ✅ Cookies valid`);
      return true;
    }

    log.warning(
      this.isAuthenticationPage()
        ? `  ⚠️  Google redirected the browser to sign-in`
        : `  ⚠️  Cookies expired or invalid`
    );

    // Try to get valid auth state
    const statePath = await this.authManager.getValidStatePath();

    if (statePath) {
      // Load saved state
      log.info(`  📂 Loading auth state from: ${statePath}`);
      await this.authManager.loadAuthState(this.context, statePath);

      // Reload page to apply new auth
      log.info(`  🔄 Reloading page...`);
      await (this.page as Page).reload({ waitUntil: "domcontentloaded" });
      await randomDelay(2000, 3000);

      // Check if it worked
      const nowValid = await this.authManager.validateCookiesExpiry(this.context);
      if (nowValid && !this.isAuthenticationPage()) {
        log.success(`  ✅ Auth state loaded successfully`);
        return true;
      }
    }

    // Need fresh login
    log.warning(`  🔑 Fresh login required`);

    if (config.autoLoginEnabled) {
      log.info(`  🤖 Attempting auto-login...`);
      const loginSuccess = await this.authManager.loginWithCredentials(
        this.context,
        this.page,
        config.loginEmail,
        config.loginPassword
      );

      if (loginSuccess) {
        log.success(`  ✅ Auto-login successful`);
        // Navigate back to notebook
        await this.page.goto(this.notebookUrl, {
          waitUntil: "domcontentloaded",
        });
        await randomDelay(2000, 3000);
        return true;
      } else {
        log.error(`  ❌ Auto-login failed`);
        return false;
      }
    } else {
      log.error(`  ❌ Auto-login disabled and no valid auth state - manual login required`);
      return false;
    }
  }

  private getOriginFromUrl(url: string): string | null {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  /**
   * Safely restore sessionStorage when the page is on the expected origin
   */
  private async restoreSessionStorage(
    sessionData: Record<string, string>,
    entryCount: number
  ): Promise<void> {
    if (!this.page) {
      log.warning(`  ⚠️  Cannot restore sessionStorage without an active page`);
      return;
    }

    const targetOrigin = this.getOriginFromUrl(this.notebookUrl);
    if (!targetOrigin) {
      log.warning(`  ⚠️  Unable to determine target origin for sessionStorage restore`);
      return;
    }

    let restored = false;

    const applyToPage = async (): Promise<boolean> => {
      if (!this.page) {
        return false;
      }

      const currentOrigin = this.getOriginFromUrl(this.page.url());
      if (currentOrigin !== targetOrigin) {
        return false;
      }

      try {
        await this.page.evaluate((data) => {
          for (const [key, value] of Object.entries(data)) {
            sessionStorage.setItem(key, value);
          }
        }, sessionData);
        restored = true;
        log.success(`  ✅ SessionStorage restored: ${entryCount} entries`);
        return true;
      } catch (error) {
        log.warning(`  ⚠️  Failed to restore sessionStorage: ${error}`);
        return false;
      }
    };

    if (await applyToPage()) {
      return;
    }

    log.info(`  ⏳ Waiting for NotebookLM origin before restoring sessionStorage...`);

    const handleNavigation = async () => {
      if (restored) {
        return;
      }

      if (await applyToPage()) {
        this.page?.off("framenavigated", handleNavigation);
      }
    };

    this.page.on("framenavigated", handleNavigation);
  }

  /**
   * Ask a question to NotebookLM
   */
  private runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    const result = this.operationTail.then(async () => {
      throwIfAborted(signal);
      this.updateActivity();
      // Only refresh activity again on success. If operation() throws (e.g.
      // it timed out after minutes of retries), keep lastActivity at the
      // pre-call timestamp so a failing session ages toward eviction instead
      // of looking freshly used every time it fails.
      const value = await operation();
      this.updateActivity();
      return value;
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async ask(
    question: string,
    sendProgress?: ProgressCallback,
    signal?: AbortSignal
  ): Promise<string> {
    return await this.runExclusive(() => this.askUnlocked(question, sendProgress, signal), signal);
  }

  async askAndExtractCitations(
    question: string,
    format: SourceFormat,
    sendProgress?: ProgressCallback,
    signal?: AbortSignal
  ): Promise<ExtractCitationsResult> {
    return await this.runExclusive(async () => {
      const answer = await this.askUnlocked(question, sendProgress, signal);
      return await this.extractCitationsUnlocked(answer, format, signal);
    }, signal);
  }

  private async askUnlocked(
    question: string,
    sendProgress?: ProgressCallback,
    signal?: AbortSignal
  ): Promise<string> {
    const config = getRuntimeConfig();
    const askOnce = async (page: Page): Promise<string> => {
      log.info(
        `💬 [${hashLogValue(this.sessionId)}] Asking question (${question.length} characters)`
      );

      // Hydrate and snapshot existing responses BEFORE asking. The current
      // NotebookLM UI virtualises history, so the textarea can be visible
      // before prior chat cards have mounted.
      log.info(`  📸 Snapshotting existing responses...`);
      const existingResponses = await snapshotPriorAnswers(page);
      log.success(`  ✅ Captured ${existingResponses.length} existing responses`);

      // Find the chat input
      const inputSelector = await this.findChatInput();
      if (!inputSelector) {
        throw new UiChangedError("chat.queryInput");
      }

      log.info(`  ⌨️  Typing question with human-like behavior...`);
      await sendProgress?.("Typing question with human-like behavior...", 2, 5);
      await humanType(page, inputSelector, question, {
        // Deliberate typos can survive UI correction and make the rendered
        // user turn differ from the request we need to correlate.
        withTypos: false,
        wpm: randomInt(config.typingWpmMin, config.typingWpmMax),
      });

      // Small pause before submitting
      await randomDelay(500, 1000);

      // Submit from the input itself so another focused control cannot consume
      // Enter. If the UI does not clear the input, fall back to the dedicated
      // submit button and fail explicitly if neither path submits the turn.
      log.info(`  📤 Submitting question...`);
      await sendProgress?.("Submitting question...", 3, 5);
      const input = page.locator(inputSelector).first();
      await input.press("Enter");

      let inputCleared = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        inputCleared = (await input.inputValue().catch(() => "")) === "";
        if (inputCleared) break;
        await page.waitForTimeout(150);
      }

      if (!inputCleared) {
        const submitButton = page.locator(joinAlt(Selectors.chat.submitButton)).first();
        if (
          (await submitButton.count()) === 0 ||
          !(await submitButton.isVisible().catch(() => false)) ||
          !(await submitButton.isEnabled().catch(() => false))
        ) {
          throw new Error("NotebookLM did not accept the question submission");
        }
        await submitButton.click();
      }

      await randomDelay(250, 500);

      // Wait for the response with streaming-stability detection (issue #43).
      // Timeout comes from the request-scoped configuration so concurrent
      // HTTP calls cannot overwrite one another's limits.
      log.info(`  ⏳ Waiting for the completed response for this turn...`);
      await sendProgress?.("Waiting for NotebookLM final response...", 3, 5);
      const answer = await waitForStableAnswer(page, {
        question,
        timeoutMs: config.answerTimeoutMs,
        pollIntervalMs: 750,
        ignoreTexts: existingResponses,
      });

      if (!answer) {
        throw new Error("Timeout waiting for response from NotebookLM");
      }

      // Check for rate limit errors AFTER receiving answer
      log.info(`  🔍 Checking for rate limit errors...`);
      if (await this.detectRateLimitError()) {
        throw new RateLimitError("NotebookLM reported a rate or quota limit");
      }

      // Update session stats
      this.messageCount++;
      this.updateActivity();

      log.success(
        `✅ [${hashLogValue(this.sessionId)}] Received answer (${answer.length} chars, ${this.messageCount} total messages)`
      );

      return answer;
    };

    await sendProgress?.("Verifying authentication...", 2, 5);
    return await this.withAuthenticatedNotebookPage("ask_question", askOnce, {
      signal,
      timeoutMs: config.answerTimeoutMs + 60_000,
    });
  }

  /**
   * Add a new source (URL or pasted text) to the active notebook page
   * (issue #25). Lazily initialises the session so the caller can use this
   * without first running `ask()`.
   */
  async addSource(input: AddSourceInput, signal?: AbortSignal): Promise<AddSourceResult> {
    return await this.runExclusive(() => this.addSourceUnlocked(input, signal), signal);
  }

  private async addSourceUnlocked(
    input: AddSourceInput,
    signal?: AbortSignal
  ): Promise<AddSourceResult> {
    return await this.withAuthenticatedNotebookPage(
      "add_source",
      (page) => addSourceToPage(page, input),
      { signal, timeoutMs: 120_000 }
    );
  }

  async listSources(signal?: AbortSignal): Promise<SourceSummary[]> {
    return await this.runExclusive(
      () =>
        this.withAuthenticatedNotebookPage("list_sources", listSourcesOnPage, {
          signal,
          timeoutMs: 30_000,
        }),
      signal
    );
  }

  async getSource(
    selector: { sourceId?: string; name?: string },
    signal?: AbortSignal
  ): Promise<SourceSummary | null> {
    return await this.runExclusive(
      () =>
        this.withAuthenticatedNotebookPage(
          "get_source",
          (page) => getSourceOnPage(page, selector),
          { signal, timeoutMs: 30_000 }
        ),
      signal
    );
  }

  /**
   * Generate an Audio Overview for the active notebook (issue #11).
   */
  async generateAudio(
    options: GenerateAudioOptions = {},
    signal?: AbortSignal
  ): Promise<AudioGenerationResult> {
    return await this.runExclusive(() => this.generateAudioUnlocked(options, signal), signal);
  }

  private async generateAudioUnlocked(
    options: GenerateAudioOptions = {},
    signal?: AbortSignal
  ): Promise<AudioGenerationResult> {
    return await this.withAuthenticatedNotebookPage(
      "generate_audio",
      (page) => generateAudioOnPage(page, options),
      { signal, timeoutMs: (options.timeoutMs ?? 600_000) + 30_000 }
    );
  }

  /**
   * Non-blocking probe for the current Audio Overview state (issue #11).
   */
  async getAudioStatus(signal?: AbortSignal): Promise<AudioGenerationResult> {
    return await this.runExclusive(() => this.getAudioStatusUnlocked(signal), signal);
  }

  private async getAudioStatusUnlocked(signal?: AbortSignal): Promise<AudioGenerationResult> {
    return await this.withAuthenticatedNotebookPage(
      "get_audio_status",
      (page) => getAudioStatusOnPage(page),
      { signal, timeoutMs: 30_000 }
    );
  }

  /**
   * Download the most recent Audio Overview (issue #11).
   */
  async downloadAudio(destinationDir: string, signal?: AbortSignal): Promise<DownloadAudioResult> {
    return await this.runExclusive(
      () => this.downloadAudioUnlocked(destinationDir, signal),
      signal
    );
  }

  private async downloadAudioUnlocked(
    destinationDir: string,
    signal?: AbortSignal
  ): Promise<DownloadAudioResult> {
    return await this.withAuthenticatedNotebookPage(
      "download_audio",
      (page) => downloadAudioOnPage(page, destinationDir),
      { signal, timeoutMs: 90_000 }
    );
  }

  private async withAuthenticatedNotebookPage<T>(
    operationName: string,
    operation: (page: Page) => Promise<T>,
    options: BrowserOperationOptions = {}
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await runWithOperationBoundary(
          operationName,
          async () => {
            if (
              !this.initialized ||
              !this.page ||
              this.isPageClosedSafe() ||
              this.isAuthenticationPage()
            ) {
              if (this.page && !this.isPageClosedSafe()) {
                await this.page.close().catch(() => undefined);
              }
              this.page = null;
              this.initialized = false;
              await this.init();
            }

            if (!this.page || this.isAuthenticationPage()) {
              throw new Error("AUTH_REQUIRED: Google requested sign-in");
            }

            const cookiesAreValid = await this.authManager.validateCookiesExpiry(this.context);
            if (!cookiesAreValid) {
              const restored = await this.ensureAuthenticated();
              if (!restored || !this.page || this.isAuthenticationPage()) {
                throw new Error("AUTH_REQUIRED: Google requested sign-in");
              }
            }

            await dismissUnexpectedOverlay(this.page);
            if (!this.page) {
              throw new Error("BROWSER_CRASHED: NotebookLM page is unavailable");
            }
            return await operation(this.page);
          },
          {
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            onInterrupt: async () => {
              if (this.page && !this.isPageClosedSafe()) {
                await this.page.close().catch(() => undefined);
              }
              this.page = null;
              this.initialized = false;
            },
          }
        );
      } catch (error) {
        if (
          attempt === 0 &&
          options.retryRecoverable !== false &&
          isRecoverableBrowserOperationError(error)
        ) {
          log.warning(`  ♻️  Recovering browser before retrying ${operationName}`);
          if (this.page && !this.isPageClosedSafe()) {
            await this.page.close().catch(() => undefined);
          }
          this.page = null;
          this.initialized = false;
          continue;
        }
        throw error;
      }
    }
    throw new Error(`${operationName} failed after browser recovery`);
  }

  /**
   * Pull DOM-level citations from the most recent answer on this session's
   * page (issue #20). Must be called immediately after `ask()` — before any
   * follow-up question disturbs the source panel.
   */
  async extractCitations(
    answer: string,
    format: SourceFormat,
    signal?: AbortSignal
  ): Promise<ExtractCitationsResult> {
    return await this.runExclusive(
      () => this.extractCitationsUnlocked(answer, format, signal),
      signal
    );
  }

  private async extractCitationsUnlocked(
    answer: string,
    format: SourceFormat,
    signal?: AbortSignal
  ): Promise<ExtractCitationsResult> {
    if (format === "none" || !this.page || this.isPageClosedSafe()) {
      return { citations: [], formattedAnswer: answer };
    }
    try {
      return await extractCitationsFromPage(this.page, answer, format, { signal });
    } catch (err) {
      throwIfAborted(signal);
      log.warning(`  ⚠️  Citation extraction failed: ${err}`);
      return { citations: [], formattedAnswer: answer };
    }
  }

  /**
   * Find the chat input element
   *
   * IMPORTANT: Matches Python implementation EXACTLY!
   * - Uses SPECIFIC selectors from Python
   * - Checks ONLY visibility (NOT disabled state!)
   *
   * Based on Python ask() method from browser_session.py:166-171
   */
  private async findChatInput(): Promise<string | null> {
    if (!this.page) {
      return null;
    }

    const tryFind = async (): Promise<string | null> => {
      return await findVisibleSelector(this.page!, "chat.queryInput", 300);
    };

    let hit = await tryFind();
    if (hit) {
      log.success(`  ✅ Found chat input: ${hit}`);
      return hit;
    }

    // Recovery: chat input is most often hidden because (a) a leftover Add-
    // source / customise modal is still mounted, (b) a citation source-panel
    // is open, or (c) we navigated to `?addSource=true` and never cleaned the
    // URL up. Try all three remedies and re-probe.
    log.warning("  ⚠️  Chat input not visible, attempting recovery…");
    try {
      await this.page.keyboard.press("Escape").catch(() => undefined);
      await this.page.keyboard.press("Escape").catch(() => undefined);
      await randomDelay(200, 400);
      hit = await tryFind();
      if (hit) {
        log.success(`  ✅ Found chat input after Escape: ${hit}`);
        return hit;
      }

      const url = this.page.url();
      if (url.includes("addSource=true") || url.includes("?")) {
        const cleanUrl = url.replace(/[?&]addSource=true/g, "").replace(/&$/, "");
        if (cleanUrl !== url) {
          log.diagnostic("Cleaning NotebookLM URL state", `${url} -> ${cleanUrl}`);
          await this.page
            .goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 15_000 })
            .catch(() => undefined);
          await randomDelay(800, 1200);
          hit = await tryFind();
          if (hit) {
            log.success(`  ✅ Found chat input after URL clean: ${hit}`);
            return hit;
          }
        }
      }

      // Last resort: reload the notebook page entirely.
      log.warning("  ⚠️  Reloading notebook page as last resort…");
      await this.page
        .goto(this.notebookUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
        .catch(() => undefined);
      await randomDelay(1500, 2500);
      hit = await tryFind();
      if (hit) {
        log.success(`  ✅ Found chat input after reload: ${hit}`);
        return hit;
      }
    } catch (err) {
      log.warning(`  ⚠️  Recovery failed: ${err}`);
    }

    log.error("  ❌ Could not find visible chat input");
    return null;
  }

  /**
   * Detect if a rate limit error occurred
   *
   * Searches the page for error messages indicating rate limit/quota exhaustion.
   * Account limits vary and can change; do not assume a fixed allowance.
   *
   * @returns true if rate limit error detected, false otherwise
   */
  private async detectRateLimitError(): Promise<boolean> {
    if (!this.page) {
      return false;
    }

    // Error message selectors (common patterns for error containers)
    // Keywords that indicate rate limiting
    const keywords = [
      "rate limit",
      "limit exceeded",
      "quota exhausted",
      "daily limit",
      "limit reached",
      "too many requests",
      "ratenlimit",
      "quota",
      "query limit",
      "request limit",
    ];

    // Check error containers for rate limit messages
    for (const selector of Selectors.chat.rateLimitContainers) {
      try {
        const elements = await this.page.$$(selector);
        for (const el of elements) {
          try {
            const text = await el.innerText();
            const lower = text.toLowerCase();

            if (keywords.some((k) => lower.includes(k))) {
              log.error(`🚫 Rate limit detected in NotebookLM UI`);
              log.diagnostic("Rate-limit UI text", text.slice(0, 500));
              return true;
            }
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    // Also check if chat input is disabled (sometimes NotebookLM disables input when rate limited)
    try {
      const inputSelector = joinAlt(Selectors.chat.queryInput);
      const input = await this.page.$(inputSelector);
      if (input) {
        const isDisabled = await input.evaluate((el) => {
          return (
            (el as HTMLTextAreaElement).disabled || (el as HTMLElement).hasAttribute("disabled")
          );
        });

        if (isDisabled) {
          // Check if there's an error message near the input
          const parent = await input.evaluateHandle((el) => el.parentElement);
          const parentEl = parent.asElement();
          if (parentEl) {
            try {
              const parentText = await parentEl.innerText();
              const lower = parentText.toLowerCase();
              if (keywords.some((k) => lower.includes(k))) {
                log.error(`🚫 Rate limit detected: Chat input disabled with error message`);
                return true;
              }
            } catch {
              // Ignore
            }
          }
        }
      }
    } catch {
      // Ignore errors checking input state
    }

    return false;
  }

  /**
   * Reset the chat history (start a new conversation)
   */
  async reset(signal?: AbortSignal): Promise<void> {
    return await this.runExclusive(
      () =>
        runWithOperationBoundary("reset_session", () => this.resetUnlocked(), {
          signal,
          timeoutMs: 60_000,
          onInterrupt: async () => {
            if (this.page && !this.isPageClosedSafe()) {
              await this.page.close().catch(() => undefined);
            }
            this.page = null;
            this.initialized = false;
          },
        }),
      signal
    );
  }

  private async resetUnlocked(): Promise<void> {
    const resetOnce = async (): Promise<void> => {
      if (!this.initialized || !this.page || this.isPageClosedSafe()) {
        await this.init();
      }
      log.info(`🔄 [${hashLogValue(this.sessionId)}] Resetting chat history...`);
      const page = this.page as Page;

      // Reloading does not clear NotebookLM's server-side conversation. Use
      // the actual "Clear chat history" action exposed by the current UI.
      const optionsButton = page.locator(joinAlt(Selectors.chat.optionsButton)).first();
      await optionsButton.waitFor({ state: "visible", timeout: 10_000 });
      await optionsButton.click();

      const clearHistoryItem = page.locator(joinAlt(Selectors.chat.clearHistoryMenuItem)).first();
      await clearHistoryItem.waitFor({ state: "visible", timeout: 5_000 });
      await clearHistoryItem.click();

      // Some NotebookLM builds ask for confirmation; others clear directly.
      await page.waitForTimeout(300);
      const dialog = page.locator('[role="dialog"]').last();
      if ((await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false))) {
        const confirmButton = dialog
          .locator(joinAlt(Selectors.chat.clearHistoryConfirmButton))
          .last();
        await confirmButton.waitFor({ state: "visible", timeout: 5_000 });
        await confirmButton.click();
      }

      const clearDeadline = Date.now() + 15_000;
      const answers = page.locator(Selectors.chat.answerContainer);
      while (Date.now() < clearDeadline && (await answers.count()) > 0) {
        await page.waitForTimeout(250);
      }
      if ((await answers.count()) > 0) {
        throw new Error("NotebookLM did not clear the chat history");
      }

      await this.waitForNotebookLMReady();

      // Reset message count
      this.messageCount = 0;
      this.updateActivity();

      log.success(`✅ [${hashLogValue(this.sessionId)}] Chat history reset`);
    };

    try {
      await resetOnce();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/has been closed|Target .* closed|Browser has been closed|Context .* closed/i.test(msg)) {
        log.warning(`  ♻️  Detected closed page/context during reset. Recovering and retrying...`);
        this.initialized = false;
        if (this.page) {
          try {
            await this.page.close();
          } catch {
            /* page already gone */
          }
        }
        this.page = null;
        await this.init();
        await resetOnce();
        return;
      }
      log.error(`❌ [${hashLogValue(this.sessionId)}] Failed to reset: ${msg}`);
      throw error;
    }
  }

  /**
   * Close the session
   */
  async close(): Promise<void> {
    return await this.runExclusive(() => this.closeUnlocked());
  }

  async closeIfExpired(timeoutSeconds: number): Promise<boolean> {
    const result = this.operationTail.then(async () => {
      if (!this.isEvictable(timeoutSeconds)) {
        return false;
      }

      await this.closeUnlocked();
      return true;
    });

    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );

    return await result;
  }

  private async closeUnlocked(): Promise<void> {
    log.info(`🛑 Closing session ${hashLogValue(this.sessionId)}...`);

    if (this.page) {
      try {
        await this.page.close();
        this.page = null;
        log.success(`  ✅ Page closed`);
      } catch (error) {
        log.warning(`  ⚠️  Error closing page: ${error}`);
      }
    }

    this.initialized = false;
    log.success(`✅ Session ${hashLogValue(this.sessionId)} closed`);
  }

  /**
   * Update last activity timestamp
   */
  updateActivity(): void {
    this.lastActivity = Date.now();
  }

  /**
   * Check if session has expired (inactive for too long)
   */
  isExpired(timeoutSeconds: number): boolean {
    const inactiveSeconds = (Date.now() - this.lastActivity) / 1000;
    return inactiveSeconds > timeoutSeconds;
  }

  /**
   * Whether this session can be evicted right now: either it timed out from
   * inactivity, or its browser page is already gone (a prior operation
   * crashed/timed out and tore it down via onInterrupt). A dead session with
   * no page left is useless but still counts against maxSessions until the
   * full sessionTimeout elapses if we only check isExpired() — that's what
   * piles up as "ghost sessions" during a retry storm, so dead sessions are
   * evictable immediately regardless of how recently they were touched.
   */
  isEvictable(timeoutSeconds: number): boolean {
    return !this.isInitialized() || this.isExpired(timeoutSeconds);
  }

  /**
   * Get session information
   */
  getInfo(): SessionInfo {
    const now = Date.now();
    return {
      id: this.sessionId,
      created_at: this.createdAt,
      last_activity: this.lastActivity,
      age_seconds: (now - this.createdAt) / 1000,
      inactive_seconds: (now - this.lastActivity) / 1000,
      message_count: this.messageCount,
      notebook_url: this.notebookUrl,
    };
  }

  /**
   * Get the underlying page (for advanced operations)
   */
  getPage(): Page | null {
    return this.page;
  }

  /**
   * Check if session is initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.page !== null;
  }
}

function isRecoverableBrowserOperationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /has been closed|target .*closed|browser.*closed|context.*closed|page.*closed|crash/i.test(
    message
  );
}
