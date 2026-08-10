import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext } from "patchright";
import type { AuthManager } from "../src/auth/auth-manager.js";
import { SharedContextManager } from "../src/session/shared-context-manager.js";

interface SharedContextManagerInternals {
  authManager: AuthManager;
  globalContext: BrowserContext | null;
  contextCreatedAt: number | null;
  currentProfileDir: string | null;
  isIsolatedProfile: boolean;
  currentHeadlessMode: boolean | null;
  pruneIsolatedProfiles(phase: "startup" | "shutdown"): Promise<void>;
}

function createManagerForTest(): {
  manager: SharedContextManager;
  internals: SharedContextManagerInternals;
} {
  const manager = Object.create(SharedContextManager.prototype) as SharedContextManager;
  const internals = manager as unknown as SharedContextManagerInternals;

  internals.globalContext = null;
  internals.contextCreatedAt = null;
  internals.currentProfileDir = null;
  internals.isIsolatedProfile = false;
  internals.currentHeadlessMode = null;

  return { manager, internals };
}

test("persistent context close failure is propagated", async () => {
  const { manager, internals } = createManagerForTest();
  const closeFailure = new Error("simulated persistent context close failure");

  let closeCalls = 0;
  let pruneCalls = 0;

  const context = {
    async close() {
      closeCalls++;
      throw closeFailure;
    },
  } as unknown as BrowserContext;

  internals.authManager = {
    async saveBrowserState() {
      // Successful best-effort backup.
    },
  } as unknown as AuthManager;

  internals.globalContext = context;
  internals.contextCreatedAt = Date.now();
  internals.currentProfileDir = null;
  internals.isIsolatedProfile = false;
  internals.currentHeadlessMode = true;
  internals.pruneIsolatedProfiles = async () => {
    pruneCalls++;
  };

  await assert.rejects(manager.closeContext(), /simulated persistent context close failure/);

  assert.equal(closeCalls, 1);
  assert.equal(internals.globalContext, context);
  assert.notEqual(internals.contextCreatedAt, null);
  assert.equal(internals.currentHeadlessMode, true);
  assert.equal(pruneCalls, 0);
});

test("browser state backup failure does not skip persistent context closing", async () => {
  const { manager, internals } = createManagerForTest();
  let closeCalls = 0;

  const context = {
    async close() {
      closeCalls++;
    },
  } as unknown as BrowserContext;

  internals.authManager = {
    async saveBrowserState() {
      throw new Error("simulated state backup failure");
    },
  } as unknown as AuthManager;
  internals.globalContext = context;
  internals.contextCreatedAt = Date.now();
  internals.currentHeadlessMode = true;

  await manager.closeContext();

  assert.equal(closeCalls, 1);
  assert.equal(internals.globalContext, null);
  assert.equal(internals.contextCreatedAt, null);
  assert.equal(internals.currentHeadlessMode, null);
});
