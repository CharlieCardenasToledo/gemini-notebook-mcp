import assert from "node:assert/strict";
import test from "node:test";
import type { CleanupManager } from "../src/utils/cleanup-manager.js";
import type { SessionManager } from "../src/session/session-manager.js";
import { ToolHandlers } from "../src/tools/handlers.js";

interface ToolHandlersInternals {
  sessionManager: SessionManager;
  cleanupManager: CleanupManager;
}

function createHandlersForCleanup(
  sessionManager: SessionManager,
  cleanupManager: CleanupManager
): ToolHandlers {
  const handlers = Object.create(ToolHandlers.prototype) as ToolHandlers;
  const internals = handlers as unknown as ToolHandlersInternals;

  internals.sessionManager = sessionManager;
  internals.cleanupManager = cleanupManager;

  return handlers;
}

test("cleanup_data preview stays inside the cleanup-safe session boundary", async () => {
  let boundaryActive = false;
  let boundaryCalls = 0;

  const sessionManager = {
    async runWithCleanupSafeContext<T>(operation: () => Promise<T>): Promise<T> {
      boundaryCalls++;
      boundaryActive = true;
      try {
        return await operation();
      } finally {
        boundaryActive = false;
      }
    },

    async prepareForCleanup() {
      assert.fail(
        "handleCleanupData must not release the session boundary before creating the preview"
      );
    },
  } as unknown as SessionManager;

  const cleanupManager = {
    async createPreview(preserveLibrary: boolean) {
      assert.equal(boundaryActive, true);
      assert.equal(preserveLibrary, true);

      return {
        mode: "data" as const,
        previewToken: "preview-token-with-more-than-thirty-two-characters",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        pathDigest: "digest",
        preserveLibrary: true,
        categories: [],
        totalPaths: [],
        totalSizeBytes: 0,
      };
    },

    formatBytes() {
      return "0 Bytes";
    },
  } as unknown as CleanupManager;

  const handlers = createHandlersForCleanup(sessionManager, cleanupManager);
  const result = await handlers.handleCleanupData({
    confirm: false,
    preserve_library: true,
  });

  assert.equal(result.success, true);
  assert.equal(result.data?.status, "preview");
  assert.equal(boundaryCalls, 1);
});

test("cleanup_data deletion stays inside the cleanup-safe session boundary", async () => {
  let boundaryActive = false;
  let boundaryCalls = 0;

  const sessionManager = {
    async runWithCleanupSafeContext<T>(operation: () => Promise<T>): Promise<T> {
      boundaryCalls++;
      boundaryActive = true;
      try {
        return await operation();
      } finally {
        boundaryActive = false;
      }
    },

    async prepareForCleanup() {
      assert.fail("handleCleanupData must not release the session boundary before deletion");
    },
  } as unknown as SessionManager;

  const cleanupManager = {
    async performCleanup(previewToken: string) {
      assert.equal(boundaryActive, true);
      assert.equal(previewToken, "confirmed-preview-token");

      return {
        success: true,
        mode: "data" as const,
        deletedPaths: [],
        failedPaths: [],
        totalSizeBytes: 0,
        categorySummary: {
          "NotebookLM MCP data": { count: 0, bytes: 0 },
        },
      };
    },
  } as unknown as CleanupManager;

  const handlers = createHandlersForCleanup(sessionManager, cleanupManager);
  const result = await handlers.handleCleanupData({
    confirm: true,
    preview_token: "confirmed-preview-token",
  });

  assert.equal(result.success, true);
  assert.equal(result.data?.status, "completed");
  assert.equal(boundaryCalls, 1);
});
