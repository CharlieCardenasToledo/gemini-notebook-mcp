import assert from "node:assert/strict";
import test from "node:test";
import type { AuthManager } from "../src/auth/auth-manager.js";
import type { SharedContextManager } from "../src/session/shared-context-manager.js";
import { BrowserSession } from "../src/session/browser-session.js";

function createSession(): BrowserSession {
  return new BrowserSession(
    "conditional-close-test",
    {} as SharedContextManager,
    {} as AuthManager,
    "https://notebook.google.com/notebook/test"
  );
}

test("conditional expiry close rechecks activity after queued browser work", async () => {
  const session = createSession();
  const internals = session as unknown as {
    withAuthenticatedNotebookPage<T>(
      operationName: string,
      operation: (page: never) => Promise<T>,
      options?: unknown
    ): Promise<T>;
  };

  let markOperationStarted!: () => void;
  const operationStarted = new Promise<void>((resolve) => {
    markOperationStarted = resolve;
  });

  let releaseOperation!: () => void;
  const operationGate = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });

  internals.withAuthenticatedNotebookPage = async () => {
    markOperationStarted();
    await operationGate;
    return [];
  };

  const operation = session.listSources();

  await operationStarted;

  session.lastActivity = Date.now() - 60_000;
  assert.equal(session.isExpired(1), true);

  const closeAttempt = session.closeIfExpired(1);

  releaseOperation();
  await operation;

  assert.equal(await closeAttempt, false);
  assert.equal(session.isExpired(1), false);
});

test("conditional expiry close closes a still inactive session", async () => {
  const session = createSession();
  session.lastActivity = Date.now() - 60_000;

  const closed = await session.closeIfExpired(1);

  assert.equal(closed, true);
});
