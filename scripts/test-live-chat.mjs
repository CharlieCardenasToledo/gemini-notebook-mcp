import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (process.env.NOTEBOOKLM_LIVE_ALLOW_MUTATION !== "true") {
  throw new Error(
    "This test writes two questions to the live NotebookLM chat. Set NOTEBOOKLM_LIVE_ALLOW_MUTATION=true to acknowledge the account-side change."
  );
}

const endpoint = new URL(process.env.NOTEBOOKLM_MCP_URL ?? "http://127.0.0.1:3000/mcp");
const client = new Client({
  name: "gemini-notebook-mcp-live-test",
  version: "1.0.0",
});
const requestOptions = {
  timeout: 240_000,
  resetTimeoutOnProgress: true,
  maxTotalTimeout: 300_000,
};

function parseResult(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "The MCP result did not contain a text payload");
  return JSON.parse(text);
}

async function ask(question, sessionId) {
  const result = await client.callTool(
    {
      name: "ask_question",
      arguments: {
        question,
        ...(sessionId ? { session_id: sessionId } : {}),
      },
    },
    undefined,
    requestOptions
  );
  const payload = parseResult(result);
  assert.equal(payload.success, true, payload.error || "ask_question failed");
  return payload.data;
}

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));

  const first = await ask("Prueba de correlación uno: responde únicamente con PRIMERA.");
  assert.match(first.answer, /\bPRIMERA\b/i);

  const second = await ask(
    "Prueba de correlación dos: responde únicamente con SEGUNDA.",
    first.session_id
  );
  assert.equal(second.session_id, first.session_id);
  assert.match(second.answer, /\bSEGUNDA\b/i);
  assert.doesNotMatch(second.answer, /\bPRIMERA\b/i);

  console.log(
    JSON.stringify(
      {
        success: true,
        session_id: first.session_id,
        first_answer: first.answer,
        second_answer: second.answer,
      },
      null,
      2
    )
  );
} finally {
  await client.close();
}
