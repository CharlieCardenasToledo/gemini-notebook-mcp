import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrowserContext, Page } from "patchright";
import { AuthManager } from "../src/auth/auth-manager.js";
import { CONFIG, withRuntimeConfig } from "../src/config.js";

test("saved authentication state does not expire based on file age", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "notebooklm-auth-"));
  const stateDir = path.join(root, "browser_state");
  const statePath = path.join(stateDir, "state.json");

  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(statePath, JSON.stringify({ cookies: [], origins: [] }), "utf-8");

    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(statePath, oldDate, oldDate);

    const manager = new AuthManager(stateDir);
    assert.equal(await manager.getValidStatePath(), statePath);
    assert.equal(await manager.hasSavedState(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed saved authentication state is rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "notebooklm-auth-"));
  const stateDir = path.join(root, "browser_state");
  const statePath = path.join(stateDir, "state.json");

  try {
    await mkdir(stateDir, { recursive: true });
    const manager = new AuthManager(stateDir);

    await writeFile(statePath, JSON.stringify({ origins: [] }), "utf-8");
    assert.equal(await manager.getValidStatePath(), null);
    assert.equal(await manager.hasSavedState(), false);

    await writeFile(statePath, "not-json", "utf-8");
    assert.equal(await manager.getValidStatePath(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic login does not wait for NotebookLM before entering the credential flow", async () => {
  const manager = new AuthManager();

  let currentUrl = "https://accounts.google.com/v3/signin/identifier";
  let waitForTimeoutCalls = 0;
  let identifierCalls = 0;

  const page = {
    async goto() {
      return null;
    },
    url() {
      return currentUrl;
    },
    async waitForTimeout() {
      waitForTimeoutCalls++;
    },
  } as unknown as Page;

  const internals = manager as unknown as {
    handleAccountChooser(page: Page, email: string): Promise<boolean>;
    fillIdentifier(page: Page, email: string): Promise<boolean>;
    fillPassword(page: Page, password: string): Promise<boolean>;
    waitForRedirectAfterLogin(page: Page, deadline: number): Promise<boolean>;
  };

  internals.handleAccountChooser = async () => false;

  internals.fillIdentifier = async () => {
    identifierCalls++;
    currentUrl = "https://accounts.google.com/challenge";
    return false;
  };

  internals.fillPassword = async () => false;
  internals.waitForRedirectAfterLogin = async () => false;

  const result = await withRuntimeConfig(
    {
      ...CONFIG,
      autoLoginTimeoutMs: 25,
    },
    () =>
      manager.loginWithCredentials({} as BrowserContext, page, "user@example.com", "test-password")
  );

  assert.equal(result, false);
  assert.equal(identifierCalls, 1);
  assert.equal(
    waitForTimeoutCalls,
    0,
    "pre-login NotebookLM checks must not poll for the full auto-login timeout"
  );
});

test("interactive login navigation uses the request-scoped browser timeout", async () => {
  const manager = new AuthManager();
  let navigationTimeout: number | undefined;
  const page = {
    context() {
      return { pages: () => [page] };
    },
    isClosed() {
      return false;
    },
    async goto(_url: string, options?: { timeout?: number }) {
      navigationTimeout = options?.timeout;
      throw new Error("navigation failed");
    },
    url() {
      return "https://accounts.google.com";
    },
  } as unknown as Page;

  const result = await withRuntimeConfig({ ...CONFIG, browserTimeout: 43_210 }, () =>
    manager.performLogin(page)
  );
  assert.equal(navigationTimeout, 43_210);
  assert.equal(result, false);
});
