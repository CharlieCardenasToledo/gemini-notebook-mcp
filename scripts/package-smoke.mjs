import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = path.resolve(process.argv[2] ?? "dist/index.js");
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
