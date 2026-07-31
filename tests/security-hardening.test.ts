import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AuthManager } from "../src/auth/auth-manager.js";
import { PROVENANCE, aiMarkerPrefix } from "../src/utils/disclaimer.js";
import { CleanupManager } from "../src/utils/cleanup-manager.js";
import { Logger } from "../src/utils/logger.js";
import { ASK_QUESTION_DESCRIPTION } from "../src/tools/definitions/ask-question.js";
import { validateToolArguments } from "../src/tools/validation.js";
import {
  prepareOutputDirectory,
  resolveOutputDirectory,
  sanitizeDownloadName,
} from "../src/notebooklm/audio.js";
import { SessionManager } from "../src/session/session-manager.js";
import type { BrowserSession } from "../src/session/browser-session.js";
import { APP_VERSION } from "../src/version.js";

test("tool metadata is static and provenance does not claim a specific Google model", () => {
  assert.doesNotMatch(ASK_QUESTION_DESCRIPTION, /active notebook|100% sure|gemini 2\.5/i);
  assert.equal(PROVENANCE.model, "google-managed");
  assert.equal(PROVENANCE.model_selection, "managed-by-notebooklm");
  assert.doesNotMatch(aiMarkerPrefix(), /gemini 2\.5/i);
});

test("runtime version comes from package.json", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string };
  assert.equal(APP_VERSION, packageJson.version);
});

test("tool arguments are rejected before browser work", () => {
  assert.throws(() => validateToolArguments("ask_question", { question: 123 }), /INVALID_ARGUMENT/);
  assert.throws(
    () =>
      validateToolArguments("ask_question", {
        question: "hello",
        browser_options: { answer_timeout_ms: -1 },
      }),
    /INVALID_ARGUMENT/
  );
  assert.throws(
    () => validateToolArguments("close_session", { session_id: "deadbeef" }),
    /INVALID_ARGUMENT/
  );
  assert.equal(validateToolArguments("ask_question", { question: "hello" }).question, "hello");
});

test("content and diagnostic logs are opt-in and common identifiers are redacted", () => {
  const output: string[] = [];
  const logger = new Logger({
    format: "json",
    level: "debug",
    content: false,
    diagnostics: false,
    sink: (message) => output.push(message),
  });

  logger.content("question", "TOP SECRET QUESTION");
  logger.diagnostic("dom", "PRIVATE DOM CONTENT");
  logger.info("open https://example.com/private for person@example.com");
  logger.warning('parse failed: SyntaxError: Unexpected token, "COOKIE SECRET" is not valid JSON');

  const rendered = output.join("\n");
  assert.doesNotMatch(rendered, /TOP SECRET|PRIVATE DOM|example\.com|person@example/);
  assert.doesNotMatch(rendered, /COOKIE SECRET/);
  assert.match(rendered, /redacted-url/);
  assert.match(rendered, /redacted-email/);
});

test("cleanup requires an unchanged preview and stays inside its configured root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "notebooklm-cleanup-"));
  try {
    await writeFile(path.join(root, "library.json"), "{}", "utf8");
    await mkdir(path.join(root, "browser_state"));
    await writeFile(path.join(root, "browser_state", "state.json"), "state", "utf8");

    const manager = new CleanupManager(root);
    const stalePreview = await manager.createPreview(true);
    await writeFile(path.join(root, "browser_state", "rotated.json"), "changed", "utf8");
    await assert.rejects(
      manager.performCleanup(stalePreview.previewToken),
      /targets changed after preview/
    );

    const preview = await manager.createPreview(true);
    const result = await manager.performCleanup(preview.previewToken);
    assert.equal(result.success, true);
    assert.equal(await readFile(path.join(root, "library.json"), "utf8"), "{}");
    await assert.rejects(readFile(path.join(root, "browser_state", "state.json"), "utf8"));
    await assert.rejects(manager.performCleanup(preview.previewToken), /already used/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audio output paths are confined and filenames are sanitized", () => {
  const root = path.resolve("safe-output-root");
  assert.equal(resolveOutputDirectory("nested", root), path.join(root, "nested"));
  assert.throws(() => resolveOutputDirectory("..", root), /OUTPUT_PATH_DENIED/);
  assert.equal(sanitizeDownloadName("../unsafe:name"), "unsafe_name.m4a");
});

test("audio output directories cannot escape through symbolic links", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "notebooklm-output-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "notebooklm-output-outside-"));
  const link = path.join(root, "linked");
  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    if (code === "EPERM" || code === "EACCES") {
      context.skip("Creating directory links is not permitted on this platform");
      return;
    }
    throw error;
  }

  try {
    await assert.rejects(prepareOutputDirectory("linked", root), /OUTPUT_PATH_DENIED/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("browser session ids are UUIDs and sessions are owner-isolated", async () => {
  const manager = new SessionManager({} as AuthManager);
  const internal = manager as unknown as {
    generateSessionId: () => string;
    sessions: Map<string, { ownerId: string; session: BrowserSession }>;
  };
  const id = internal.generateSessionId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  const fakeSession = {
    close: async () => undefined,
    getInfo: () => ({
      id,
      created_at: 0,
      last_activity: 0,
      age_seconds: 0,
      inactive_seconds: 0,
      message_count: 0,
      notebook_url: "https://notebook.google.com/notebook/test",
    }),
  } as unknown as BrowserSession;
  internal.sessions.set(id, { ownerId: "owner-a", session: fakeSession });

  assert.equal(manager.getSession(id, "owner-a"), fakeSession);
  assert.equal(manager.getSession(id, "owner-b"), null);
  assert.equal(manager.getAllSessionsInfo("owner-b").length, 0);
  assert.equal(await manager.closeSession(id, "owner-b"), false);
  assert.equal(await manager.closeSession(id, "owner-a"), true);
  await manager.shutdown();
});
