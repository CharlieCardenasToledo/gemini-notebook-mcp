import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  classifyLiveFailure,
  extractToolPayload,
  redactLiveDiagnostic,
} from "../dist/utils/live-smoke.js";

const entryArgument = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const entry = path.resolve(entryArgument ?? "dist/index.js");
const preflightOnly = process.argv.includes("--preflight-only");
const preflightDataDir = preflightOnly
  ? await mkdtemp(path.join(tmpdir(), "notebooklm-live-preflight-"))
  : null;
const client = new Client({ name: "notebooklm-live-readonly-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  // Server logs are already content/diagnostic-redacted below. Inheriting
  // stderr keeps startup failures observable without contaminating JSON stdout.
  stderr: "inherit",
  env: {
    ...process.env,
    LOG_LEVEL: "error",
    LOG_CONTENT: "false",
    LOG_DIAGNOSTICS: "false",
    NO_COLOR: "1",
    ...(preflightDataDir && { NOTEBOOKLM_DATA_DIR: preflightDataDir }),
  },
});

const report = {
  version: process.env.npm_package_version ?? null,
  mode: preflightOnly ? "preflight" : "read-only",
  outcome: "pass",
  checks: [],
};
let selectedNotebook = null;

function dataObject(payload) {
  return payload.data && typeof payload.data === "object" ? payload.data : {};
}

async function callReadOnly(name, arguments_, summarize) {
  const startedAt = Date.now();
  try {
    const result = await client.callTool({ name, arguments: arguments_ }, undefined, {
      timeout: 120_000,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: 150_000,
    });
    const payload = extractToolPayload(result);
    if (payload.success !== true) {
      const disposition = classifyLiveFailure(payload);
      report.checks.push({
        name,
        status: disposition,
        duration_ms: Date.now() - startedAt,
        code:
          typeof payload.error_details === "object" && payload.error_details
            ? (payload.error_details.code ?? "UNKNOWN")
            : "UNKNOWN",
        diagnostic: redactLiveDiagnostic(payload.error),
      });
      if (disposition === "fail") report.outcome = "fail";
      else if (report.outcome === "pass") report.outcome = "skip";
      return null;
    }
    const data = dataObject(payload);
    report.checks.push({
      name,
      status: "pass",
      duration_ms: Date.now() - startedAt,
      summary: summarize(data),
    });
    return data;
  } catch (error) {
    report.outcome = "fail";
    report.checks.push({
      name,
      status: "fail",
      duration_ms: Date.now() - startedAt,
      code: "RUNNER_ERROR",
      diagnostic: redactLiveDiagnostic(error),
    });
    return null;
  }
}

try {
  await client.connect(transport);
  const health = await callReadOnly("get_health", {}, (data) => ({
    auth_state_present: data.auth_state_present === true,
    local_notebooks: Number(data.total_notebooks ?? 0),
  }));

  if (!preflightOnly) {
    const account = await callReadOnly("list_account_notebooks", {}, (data) => ({
      notebook_count: Array.isArray(data.notebooks) ? data.notebooks.length : 0,
    }));
    const accountNotebooks = Array.isArray(account?.notebooks) ? account.notebooks : [];
    const preferredGoogleId = process.env.NOTEBOOKLM_LIVE_NOTEBOOK_ID;
    const accountNotebook =
      accountNotebooks.find((notebook) => notebook?.id === preferredGoogleId) ??
      accountNotebooks[0];

    if (accountNotebook?.url) {
      selectedNotebook = { notebook_url: accountNotebook.url };
    } else if (health?.active_notebook_id) {
      selectedNotebook = { notebook_id: health.active_notebook_id };
    }

    if (!selectedNotebook) {
      if (report.outcome === "pass") report.outcome = "skip";
      report.checks.push({
        name: "select_readonly_notebook",
        status: "skip",
        duration_ms: 0,
        code: "NO_NOTEBOOK_AVAILABLE",
        diagnostic: "No account or active library notebook was available",
      });
    } else {
      const sources = await callReadOnly("list_sources", selectedNotebook, (data) => ({
        source_count: Number(data.count ?? 0),
        statuses: Array.isArray(data.sources)
          ? data.sources.reduce((counts, source) => {
              const status = typeof source?.status === "string" ? source.status : "unknown";
              counts[status] = (counts[status] ?? 0) + 1;
              return counts;
            }, {})
          : {},
      }));
      const firstSource = Array.isArray(sources?.sources) ? sources.sources[0] : null;
      if (firstSource?.source_id) {
        await callReadOnly(
          "get_source_status",
          { ...selectedNotebook, source_id: firstSource.source_id },
          (data) => ({ status: data.source?.status ?? "unknown" })
        );
      }
      await callReadOnly("get_audio_status", selectedNotebook, (data) => ({
        status: data.result?.status ?? "unknown",
      }));
      await callReadOnly("sync_library", { apply: false }, (data) => ({
        added: data.sync?.added?.length ?? 0,
        updated: data.sync?.updated?.length ?? 0,
        missing: data.sync?.missing?.length ?? 0,
        unchanged: data.sync?.unchanged ?? 0,
      }));
    }
  }

  await callReadOnly("list_artifacts", {}, (data) => ({
    artifact_jobs: Array.isArray(data.artifacts) ? data.artifacts.length : 0,
  }));
} catch (error) {
  report.outcome = "fail";
  report.checks.push({
    name: "initialize",
    status: "fail",
    duration_ms: 0,
    code: "MCP_STARTUP_FAILED",
    diagnostic: redactLiveDiagnostic(error),
  });
} finally {
  await client.close().catch(() => undefined);
  if (preflightDataDir) await rm(preflightDataDir, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
if (report.outcome === "fail") process.exitCode = 1;
else if (report.outcome === "skip") process.exitCode = 2;
