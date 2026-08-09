import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const entry = path.resolve(process.argv[2] ?? "dist/cli.js");
const packageRoot = path.dirname(path.dirname(entry));
const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin["gemini-notebook-mcp"];
assert.equal(typeof bin, "string");
const binPath = path.resolve(packageRoot, bin);
assert.equal(path.relative(packageRoot, binPath).startsWith(".."), false);
const browser = await execFileAsync(process.execPath, [binPath, "browser", "status", "--json"], {
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
});
const browserStatus = JSON.parse(browser.stdout);
assert.equal(browserStatus.browser, "chromium");
assert.equal(typeof browserStatus.installed, "boolean");
assert.equal(typeof browserStatus.hermetic, "boolean");
assert.equal(typeof browserStatus.patchrightVersion, "string");
assert.ok(browserStatus.patchrightVersion.length > 0);
const expectedVersion = process.env.npm_package_version;
const client = new Client({ name: "package-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const serverVersion = client.getServerVersion();

  assert.equal(serverVersion?.name, "notebooklm-mcp");
  if (expectedVersion) assert.equal(serverVersion?.version, expectedVersion);
  assert.ok(tools.tools.length >= 20, `Expected at least 20 tools, received ${tools.tools.length}`);
  assert.ok(tools.tools.some((tool) => tool.name === "ask_question"));
  assert.ok(tools.tools.some((tool) => tool.name === "get_health"));
  console.log(`Package smoke passed: ${serverVersion?.version}, ${tools.tools.length} tools`);
} finally {
  await client.close();
}
