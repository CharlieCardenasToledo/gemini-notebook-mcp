import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { startHttpTransport } from "../src/transport/http.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function requestStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

test("HTTP health endpoint accepts local requests and rejects hostile origins", async () => {
  const handle = await startHttpTransport({
    port: 0,
    host: "127.0.0.1",
    connect: async () => undefined,
  });

  try {
    const address = handle.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/healthz`;

    const healthy = await fetch(url);
    assert.equal(healthy.status, 200);

    const hostile = await fetch(url, {
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(hostile.status, 403);
  } finally {
    await handle.close();
  }
});

test("non-loopback HTTP binding requires a bearer token", async () => {
  await assert.rejects(
    startHttpTransport({
      port: 0,
      host: "0.0.0.0",
      connect: async () => undefined,
    }),
    /requires NOTEBOOKLM_HTTP_AUTH_TOKEN/
  );
});

test("creates an independent MCP server for each concurrent HTTP client", async () => {
  let serverCount = 0;
  const handle = await startHttpTransport({
    port: 0,
    host: "127.0.0.1",
    connect: async (transport) => {
      const instance = ++serverCount;
      const server = new Server(
        { name: `test-server-${instance}`, version: "1.0.0" },
        { capabilities: { tools: {} } }
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: `tool-${instance}`,
            description: "test tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }));
      await server.connect(transport);
    },
  });

  const address = handle.server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const clientA = new Client({ name: "client-a", version: "1.0.0" });
  const clientB = new Client({ name: "client-b", version: "1.0.0" });

  try {
    await Promise.all([
      clientA.connect(new StreamableHTTPClientTransport(endpoint)),
      clientB.connect(new StreamableHTTPClientTransport(endpoint)),
    ]);
    const [toolsA, toolsB] = await Promise.all([clientA.listTools(), clientB.listTools()]);

    assert.equal(serverCount, 2);
    assert.notEqual(toolsA.tools[0]?.name, toolsB.tools[0]?.name);
  } finally {
    await Promise.allSettled([clientA.close(), clientB.close()]);
    await handle.close();
  }
});

test("HTTP transport rejects invalid auth, host, oversized bodies, and unknown sessions", async () => {
  const handle = await startHttpTransport({
    port: 0,
    host: "127.0.0.1",
    authToken: "test-secret",
    maxBodyBytes: 64,
    connect: async () => undefined,
  });

  try {
    const address = handle.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 401);
    assert.equal(
      (
        await fetch(`${baseUrl}/healthz`, {
          headers: { Authorization: "Bearer wrong-secret" },
        })
      ).status,
      401
    );
    assert.equal(
      await requestStatus(`${baseUrl}/healthz`, {
        Authorization: "Bearer test-secret",
        Host: "attacker.example",
      }),
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: {
            Authorization: "Bearer test-secret",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ payload: "x".repeat(100) }),
        })
      ).status,
      413
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/mcp`, {
          headers: {
            Authorization: "Bearer test-secret",
            "Mcp-Session-Id": "00000000-0000-4000-8000-000000000000",
          },
        })
      ).status,
      404
    );
  } finally {
    await handle.close();
  }
});

test("HTTP transport enforces its concurrent session limit", async () => {
  const handle = await startHttpTransport({
    port: 0,
    host: "127.0.0.1",
    maxSessions: 1,
    connect: async (transport) => {
      const server = new Server(
        { name: "limited-test-server", version: "1.0.0" },
        { capabilities: { tools: {} } }
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
      await server.connect(transport);
    },
  });

  const address = handle.server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const clientA = new Client({ name: "limited-a", version: "1.0.0" });
  const clientB = new Client({ name: "limited-b", version: "1.0.0" });

  try {
    await clientA.connect(new StreamableHTTPClientTransport(endpoint));
    await assert.rejects(
      clientB.connect(new StreamableHTTPClientTransport(endpoint)),
      /429|too many active MCP sessions/i
    );
  } finally {
    await Promise.allSettled([clientA.close(), clientB.close()]);
    await handle.close();
  }
});

test("HTTP session limit reserves slots during concurrent initialization", async () => {
  let connectCalls = 0;

  let markFirstConnectStarted!: () => void;
  const firstConnectStarted = new Promise<void>((resolve) => {
    markFirstConnectStarted = resolve;
  });

  let releaseFirstConnect!: () => void;
  const firstConnectGate = new Promise<void>((resolve) => {
    releaseFirstConnect = resolve;
  });

  const servers: Server[] = [];

  const handle = await startHttpTransport({
    port: 0,
    host: "127.0.0.1",
    maxSessions: 1,
    connect: async (transport) => {
      const call = ++connectCalls;

      if (call === 1) {
        markFirstConnectStarted();
        await firstConnectGate;
      }

      const server = new Server(
        { name: `reserved-slot-${call}`, version: "1.0.0" },
        { capabilities: { tools: {} } }
      );

      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [],
      }));

      servers.push(server);
      await server.connect(transport);
    },
  });

  const address = handle.server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);

  const clientA = new Client({
    name: "reserved-slot-a",
    version: "1.0.0",
  });

  const clientB = new Client({
    name: "reserved-slot-b",
    version: "1.0.0",
  });

  try {
    const connectA = clientA.connect(new StreamableHTTPClientTransport(endpoint));

    await firstConnectStarted;

    const connectB = clientB.connect(new StreamableHTTPClientTransport(endpoint));
    const resultBPromise = Promise.allSettled([connectB]);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    releaseFirstConnect();

    await connectA;

    const resultB = await resultBPromise;

    assert.equal(resultB[0]?.status, "rejected");

    if (resultB[0]?.status === "rejected") {
      assert.match(String(resultB[0].reason), /429|too many active MCP sessions/i);
    }

    assert.equal(
      connectCalls,
      1,
      "the rejected initialization must not consume a second server connection"
    );
  } finally {
    releaseFirstConnect();
    await Promise.allSettled([
      clientA.close(),
      clientB.close(),
      ...servers.map((server) => server.close()),
    ]);
    await handle.close();
  }
});
