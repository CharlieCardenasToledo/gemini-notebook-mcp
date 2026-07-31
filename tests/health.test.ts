import assert from "node:assert/strict";
import test from "node:test";
import type { AuthManager } from "../src/auth/auth-manager.js";
import type { NotebookLibrary } from "../src/library/notebook-library.js";
import type { SessionManager } from "../src/session/session-manager.js";
import { ToolHandlers } from "../src/tools/handlers.js";

function createHandlers(authStatePresent: boolean): ToolHandlers {
  const sessions = {
    getStats: () => ({
      active_sessions: 0,
      max_sessions: 10,
      session_timeout: 900,
      oldest_session_seconds: 0,
      total_messages: 0,
    }),
  } as unknown as SessionManager;
  const auth = {
    hasSavedState: async () => authStatePresent,
  } as unknown as AuthManager;
  const library = {
    getActiveNotebook: () => null,
    getStats: () => ({ total_notebooks: 0 }),
  } as unknown as NotebookLibrary;

  return new ToolHandlers(sessions, auth, library);
}

test("get_health separates saved state from live authentication", async () => {
  const result = await createHandlers(true).handleGetHealth();

  assert.equal(result.success, true);
  assert.equal(result.data?.auth_state_present, true);
  assert.equal(result.data?.authenticated, null);
  assert.match(result.data?.authentication_check ?? "", /opening NotebookLM/);
  assert.equal(result.data?.troubleshooting_tip, undefined);
});

test("get_health never recommends destructive cleanup for a missing backup", async () => {
  const result = await createHandlers(false).handleGetHealth();
  const tip = result.data?.troubleshooting_tip ?? "";

  assert.equal(result.data?.auth_state_present, false);
  assert.equal(result.data?.authenticated, null);
  assert.doesNotMatch(tip, /cleanup_data|re_auth/);
  assert.match(tip, /only if Google requests sign-in/);
});
