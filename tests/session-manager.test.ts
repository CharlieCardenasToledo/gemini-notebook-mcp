import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserSession } from "../src/session/browser-session.js";
import type { SharedContextManager } from "../src/session/shared-context-manager.js";
import { SessionManager } from "../src/session/session-manager.js";

interface FakeSession {
  notebookUrl: string;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  closeCalls: number;
  updateActivity(): void;
  isExpired(timeoutSeconds: number): boolean;
  close(): Promise<void>;
}

interface SessionManagerInternals {
  sessions: Map<string, { ownerId: string; session: BrowserSession }>;
  sharedContextManager: SharedContextManager;
  sessionTimeout: number;
  maxSessions: number;
  sessionMutationTail: Promise<void>;
  getOrCreateSessionUnlocked: (
    sessionId?: string,
    notebookUrl?: string,
    overrideHeadless?: boolean,
    ownerId?: string
  ) => Promise<BrowserSession>;
}

function createManagerForTest(): {
  manager: SessionManager;
  internals: SessionManagerInternals;
} {
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  const internals = manager as unknown as SessionManagerInternals;

  internals.sessions = new Map();
  internals.sessionTimeout = 1;
  internals.maxSessions = 10;
  internals.sessionMutationTail = Promise.resolve();

  return { manager, internals };
}

function createFakeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  const session: FakeSession = {
    notebookUrl: "https://notebook.google.com/notebook/test-notebook",
    createdAt: Date.now() - 60_000,
    lastActivity: Date.now() - 60_000,
    messageCount: 0,
    closeCalls: 0,

    updateActivity() {
      this.lastActivity = Date.now();
    },

    isExpired(timeoutSeconds: number) {
      return (Date.now() - this.lastActivity) / 1000 > timeoutSeconds;
    },

    async close() {
      this.closeCalls++;
    },

    ...overrides,
  };

  return session;
}

test("inactive cleanup waits for an in-progress session reuse", async () => {
  const { manager, internals } = createManagerForTest();

  const sessionId = "2d635024-b169-4902-8c84-5cbcb809bcad";
  const ownerId = "test-owner";
  const session = createFakeSession();

  internals.sessions.set(sessionId, {
    ownerId,
    session: session as unknown as BrowserSession,
  });

  let markReuseStarted!: () => void;
  const reuseStarted = new Promise<void>((resolve) => {
    markReuseStarted = resolve;
  });

  let releaseReuse!: () => void;
  const reuseGate = new Promise<void>((resolve) => {
    releaseReuse = resolve;
  });

  internals.getOrCreateSessionUnlocked = async () => {
    markReuseStarted();
    await reuseGate;
    session.updateActivity();
    return session as unknown as BrowserSession;
  };

  const reusePromise = manager.getOrCreateSession(
    sessionId,
    session.notebookUrl,
    undefined,
    ownerId
  );

  await reuseStarted;

  const cleanupPromise = manager.cleanupInactiveSessions();

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  assert.equal(
    session.closeCalls,
    0,
    "cleanup must not close a session while its reuse mutation is still in progress"
  );

  releaseReuse();

  await reusePromise;

  const cleaned = await cleanupPromise;

  assert.equal(cleaned, 0);
  assert.equal(session.closeCalls, 0);
  assert.equal(internals.sessions.has(sessionId), true);
});

test("inactive cleanup reports only successfully closed sessions", async () => {
  const { manager, internals } = createManagerForTest();

  const sessionId = "e440009b-1e35-4822-ae95-ef47bf5a37a6";

  const session = createFakeSession({
    async close() {
      this.closeCalls++;
      throw new Error("simulated close failure");
    },
  });

  internals.sessions.set(sessionId, {
    ownerId: "test-owner",
    session: session as unknown as BrowserSession,
  });

  const cleaned = await manager.cleanupInactiveSessions();

  assert.equal(session.closeCalls, 1);
  assert.equal(cleaned, 0);
  assert.equal(internals.sessions.has(sessionId), true);
});

test("explicit close cannot delete a session created by a concurrent mutation", async () => {
  const { manager, internals } = createManagerForTest();

  const sessionId = "6c5408f8-58e5-4e95-9f5a-e25fe0ed28a2";
  const ownerId = "test-owner";

  let markCloseStarted!: () => void;
  const closeStarted = new Promise<void>((resolve) => {
    markCloseStarted = resolve;
  });

  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });

  const oldSession = createFakeSession({
    async close() {
      this.closeCalls++;
      markCloseStarted();
      await closeGate;
    },
  });

  const newSession = createFakeSession({
    createdAt: Date.now(),
    lastActivity: Date.now(),
  });

  internals.sessions.set(sessionId, {
    ownerId,
    session: oldSession as unknown as BrowserSession,
  });

  const closePromise = manager.closeSession(sessionId, ownerId);

  await closeStarted;

  let replacementStarted = false;

  internals.getOrCreateSessionUnlocked = async () => {
    replacementStarted = true;

    internals.sessions.set(sessionId, {
      ownerId,
      session: newSession as unknown as BrowserSession,
    });

    return newSession as unknown as BrowserSession;
  };

  const replacementPromise = manager.getOrCreateSession(
    sessionId,
    newSession.notebookUrl,
    undefined,
    ownerId
  );

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  assert.equal(
    replacementStarted,
    false,
    "a replacement mutation must wait until the explicit close mutation finishes"
  );

  releaseClose();

  assert.equal(await closePromise, true);

  const replacement = await replacementPromise;

  assert.equal(replacement, newSession as unknown as BrowserSession);
  assert.equal(oldSession.closeCalls, 1);
  assert.equal(
    internals.sessions.get(sessionId)?.session,
    newSession as unknown as BrowserSession,
    "the completed close must not delete the replacement session"
  );
});

test("notebook close cannot delete a session created by a concurrent mutation", async () => {
  const { manager, internals } = createManagerForTest();

  const sessionId = "a9be513c-061a-47a8-b776-d92966e5a550";
  const ownerId = "test-owner";
  const notebookUrl = "https://notebook.google.com/notebook/shared-notebook";

  let markCloseStarted!: () => void;
  const closeStarted = new Promise<void>((resolve) => {
    markCloseStarted = resolve;
  });

  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });

  const oldSession = createFakeSession({
    notebookUrl,
    async close() {
      this.closeCalls++;
      markCloseStarted();
      await closeGate;
    },
  });

  const newSession = createFakeSession({
    notebookUrl,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  });

  internals.sessions.set(sessionId, {
    ownerId,
    session: oldSession as unknown as BrowserSession,
  });

  const closePromise = manager.closeSessionsForNotebook(notebookUrl, ownerId);

  await closeStarted;

  let replacementStarted = false;

  internals.getOrCreateSessionUnlocked = async () => {
    replacementStarted = true;

    internals.sessions.set(sessionId, {
      ownerId,
      session: newSession as unknown as BrowserSession,
    });

    return newSession as unknown as BrowserSession;
  };

  const replacementPromise = manager.getOrCreateSession(sessionId, notebookUrl, undefined, ownerId);

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  assert.equal(
    replacementStarted,
    false,
    "a replacement mutation must wait until notebook session closing finishes"
  );

  releaseClose();

  assert.equal(await closePromise, 1);

  const replacement = await replacementPromise;

  assert.equal(replacement, newSession as unknown as BrowserSession);
  assert.equal(oldSession.closeCalls, 1);
  assert.equal(
    internals.sessions.get(sessionId)?.session,
    newSession as unknown as BrowserSession,
    "the notebook close must not delete a later replacement session"
  );
});

test("close all sessions cannot delete a session created by a concurrent mutation", async () => {
  const { manager, internals } = createManagerForTest();

  const sessionId = "f1969cf1-e59a-479d-a077-d56f02eb79e0";
  const ownerId = "test-owner";

  let markCloseStarted!: () => void;
  const closeStarted = new Promise<void>((resolve) => {
    markCloseStarted = resolve;
  });

  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });

  const oldSession = createFakeSession({
    async close() {
      this.closeCalls++;
      markCloseStarted();
      await closeGate;
    },
  });

  const newSession = createFakeSession({
    createdAt: Date.now(),
    lastActivity: Date.now(),
  });

  let closeContextCalls = 0;

  internals.sharedContextManager = {
    async closeContext() {
      closeContextCalls++;
    },
  } as unknown as SharedContextManager;

  internals.sessions.set(sessionId, {
    ownerId,
    session: oldSession as unknown as BrowserSession,
  });

  const closeAllPromise = manager.closeAllSessions();

  await closeStarted;

  let replacementStarted = false;

  internals.getOrCreateSessionUnlocked = async () => {
    replacementStarted = true;

    internals.sessions.set(sessionId, {
      ownerId,
      session: newSession as unknown as BrowserSession,
    });

    return newSession as unknown as BrowserSession;
  };

  const replacementPromise = manager.getOrCreateSession(
    sessionId,
    newSession.notebookUrl,
    undefined,
    ownerId
  );

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  assert.equal(
    replacementStarted,
    false,
    "session creation must wait until closeAllSessions finishes"
  );

  releaseClose();

  await closeAllPromise;

  const replacement = await replacementPromise;

  assert.equal(replacement, newSession as unknown as BrowserSession);
  assert.equal(oldSession.closeCalls, 1);
  assert.equal(closeContextCalls, 1);
  assert.equal(
    internals.sessions.get(sessionId)?.session,
    newSession as unknown as BrowserSession,
    "closeAllSessions must not delete a session created by the next mutation"
  );
});

test("browser mode change does not deadlock inside the session mutation queue", async () => {
  const { manager, internals } = createManagerForTest();

  let closeContextCalls = 0;

  internals.sharedContextManager = {
    needsHeadlessModeChange() {
      return true;
    },
    getCurrentHeadlessMode() {
      return true;
    },
    async closeContext() {
      closeContextCalls++;
    },
    async getOrCreateContext() {
      throw new Error("stop-after-mode-change-close");
    },
  } as unknown as SharedContextManager;

  const operation = manager.getOrCreateSession(
    "mode-change-session",
    "https://notebook.google.com/notebook/mode-change-test",
    false,
    "test-owner"
  );

  const deadlockGuard = new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      reject(new Error("session mutation deadlocked"));
    }, 250);
  });

  await assert.rejects(Promise.race([operation, deadlockGuard]), /stop-after-mode-change-close/);

  assert.equal(closeContextCalls, 1);
});
