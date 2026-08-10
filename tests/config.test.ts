import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CONFIG, applyBrowserOptions, getRuntimeConfig, withRuntimeConfig } from "../src/config.js";

test("single profile strategy is the authentication-safe default", () => {
  assert.equal(CONFIG.profileStrategy, "single");
});

test("request-scoped browser options do not mutate global configuration", async () => {
  const visible = applyBrowserOptions({ show: true, timeout_ms: 1234 });
  const hidden = applyBrowserOptions({ show: false, timeout_ms: 5678 });

  const [visibleResult, hiddenResult] = await Promise.all([
    withRuntimeConfig(visible, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return getRuntimeConfig();
    }),
    withRuntimeConfig(hidden, async () => getRuntimeConfig()),
  ]);

  assert.equal(visibleResult.headless, false);
  assert.equal(visibleResult.browserTimeout, 1234);
  assert.equal(hiddenResult.headless, true);
  assert.equal(hiddenResult.browserTimeout, 5678);
  assert.equal(getRuntimeConfig(), CONFIG);
});

test("invalid non-positive environment limits fall back to safe defaults", () => {
  const script = `
    const { CONFIG } = await import("./src/config.ts");
    console.log(JSON.stringify({
      browserTimeout: CONFIG.browserTimeout,
      answerTimeoutMs: CONFIG.answerTimeoutMs,
      maxSessions: CONFIG.maxSessions,
      sessionTimeout: CONFIG.sessionTimeout,
      autoLoginTimeoutMs: CONFIG.autoLoginTimeoutMs
    }));
  `;

  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BROWSER_TIMEOUT: "0",
      ANSWER_TIMEOUT_MS: "-1",
      MAX_SESSIONS: "0",
      SESSION_TIMEOUT: "-1",
      AUTO_LOGIN_TIMEOUT_MS: "0",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);

  const config = JSON.parse(result.stdout.trim());

  assert.deepEqual(config, {
    browserTimeout: 30000,
    answerTimeoutMs: 600000,
    maxSessions: 10,
    sessionTimeout: 900,
    autoLoginTimeoutMs: 120000,
  });
});

test("malformed and overflowing positive environment limits fall back to safe defaults", () => {
  const script = `
    const { CONFIG } = await import("./src/config.ts");
    console.log(JSON.stringify({
      browserTimeout: CONFIG.browserTimeout,
      answerTimeoutMs: CONFIG.answerTimeoutMs,
      maxSessions: CONFIG.maxSessions,
      sessionTimeout: CONFIG.sessionTimeout,
      autoLoginTimeoutMs: CONFIG.autoLoginTimeoutMs
    }));
  `;

  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BROWSER_TIMEOUT: "2147483648",
      ANSWER_TIMEOUT_MS: "600000ms",
      MAX_SESSIONS: "7garbage",
      SESSION_TIMEOUT: "3.5",
      AUTO_LOGIN_TIMEOUT_MS: "999999999999",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);

  const config = JSON.parse(result.stdout.trim());

  assert.deepEqual(config, {
    browserTimeout: 30000,
    answerTimeoutMs: 600000,
    maxSessions: 10,
    sessionTimeout: 900,
    autoLoginTimeoutMs: 120000,
  });
});
