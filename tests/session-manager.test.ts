import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserSession } from "../src/session/browser-session.js";
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
