import assert from "node:assert/strict";
import test from "node:test";
import type { AuthManager } from "../src/auth/auth-manager.js";
import type { SessionManager } from "../src/session/session-manager.js";
import { ToolHandlers } from "../src/tools/handlers.js";
import { getRuntimeConfig } from "../src/config.js";

interface ToolHandlersInternals {
  sessionManager: SessionManager;
  authManager: AuthManager;
}

function createHandlersForSetupAuth(
  sessionManager: SessionManager,
  authManager: AuthManager
): ToolHandlers {
  const handlers = Object.create(ToolHandlers.prototype) as ToolHandlers;

  const internals = handlers as unknown as ToolHandlersInternals;

  internals.sessionManager = sessionManager;
  internals.authManager = authManager;

  return handlers;
}

test("setup_auth keeps interactive login inside the closed browser context boundary", async () => {
  const events: string[] = [];
  let boundaryActive = false;
  let boundaryCalls = 0;

  const sessionManager = {
    async runWithClosedBrowserContext<T>(operation: () => Promise<T>): Promise<T> {
      boundaryCalls++;
      events.push("boundary:start");
      boundaryActive = true;

      try {
        return await operation();
      } finally {
        boundaryActive = false;
        events.push("boundary:end");
      }
    },

    async closeAllSessions() {
      assert.fail("handleSetupAuth must not close sessions outside the protected lifecycle");
    },
  } as unknown as SessionManager;

  const authManager = {
    async performSetup(_progress: unknown, showBrowser: boolean) {
      assert.equal(
        boundaryActive,
        true,
        "interactive setup must run inside the protected lifecycle"
      );
      assert.equal(showBrowser, true);

      events.push("auth:setup");
      return true;
    },

    async clearAllAuthData() {
      assert.fail("setup_auth must preserve the existing authentication profile");
    },
  } as unknown as AuthManager;

  const handlers = createHandlersForSetupAuth(sessionManager, authManager);

  const result = await handlers.handleSetupAuth({});

  assert.equal(result.success, true);
  assert.equal(result.data?.authenticated, true);
  assert.equal(boundaryCalls, 1);

  assert.deepEqual(events, ["boundary:start", "auth:setup", "boundary:end"]);
});

test("setup_auth forwards effective browser options to interactive setup", async () => {
  const seen: { showBrowser?: boolean; timeout?: number } = {};
  const sessionManager = {
    async runWithClosedBrowserContext<T>(operation: () => Promise<T>): Promise<T> {
      return operation();
    },
  } as unknown as SessionManager;
  const authManager = {
    async performSetup(_progress: unknown, showBrowser: boolean) {
      seen.showBrowser = showBrowser;
      seen.timeout = getRuntimeConfig().browserTimeout;
      return true;
    },
  } as unknown as AuthManager;
  const handlers = createHandlersForSetupAuth(sessionManager, authManager);

  await handlers.handleSetupAuth({
    show_browser: true,
    browser_options: { headless: true, timeout_ms: 45_000 },
  });
  assert.deepEqual(seen, { showBrowser: false, timeout: 45_000 });

  await handlers.handleSetupAuth({ browser_options: { show: false } });
  assert.equal(seen.showBrowser, false);

  await handlers.handleSetupAuth({ show_browser: false, browser_options: { headless: false } });
  assert.equal(seen.showBrowser, true);
});
