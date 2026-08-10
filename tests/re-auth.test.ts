import assert from "node:assert/strict";
import test from "node:test";
import type { AuthManager } from "../src/auth/auth-manager.js";
import type { SessionManager } from "../src/session/session-manager.js";
import { ToolHandlers } from "../src/tools/handlers.js";

interface ToolHandlersInternals {
  sessionManager: SessionManager;
  authManager: AuthManager;
}

function createHandlersForReAuth(
  sessionManager: SessionManager,
  authManager: AuthManager
): ToolHandlers {
  const handlers = Object.create(ToolHandlers.prototype) as ToolHandlers;

  const internals = handlers as unknown as ToolHandlersInternals;

  internals.sessionManager = sessionManager;
  internals.authManager = authManager;

  return handlers;
}

test("re_auth keeps auth reset and setup inside the session mutation boundary", async () => {
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
      assert.fail("handleReAuth must not call closeAllSessions outside the protected lifecycle");
    },
  } as unknown as SessionManager;

  const authManager = {
    async clearAllAuthData() {
      assert.equal(
        boundaryActive,
        true,
        "auth data must be cleared inside the protected lifecycle"
      );
      events.push("auth:clear");
    },

    async performSetup() {
      assert.equal(
        boundaryActive,
        true,
        "interactive setup must remain inside the protected lifecycle"
      );
      events.push("auth:setup");
      return true;
    },
  } as unknown as AuthManager;

  const handlers = createHandlersForReAuth(sessionManager, authManager);

  const result = await handlers.handleReAuth({});

  assert.equal(result.success, true);
  assert.equal(result.data?.authenticated, true);
  assert.equal(boundaryCalls, 1);

  assert.deepEqual(events, ["boundary:start", "auth:clear", "auth:setup", "boundary:end"]);
});
