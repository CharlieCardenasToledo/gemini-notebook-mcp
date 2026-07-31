import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthManager } from "../src/auth/auth-manager.js";

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
