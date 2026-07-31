import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseHTML } from "linkedom";
import type { Page } from "patchright";
import { NotebookLibrary } from "../src/library/notebook-library.js";
import { ArtifactStore } from "../src/notebooklm/artifact-store.js";
import { extractCitations } from "../src/notebooklm/citations.js";
import { listSources } from "../src/notebooklm/sources.js";
import { buildToolDefinitions } from "../src/tools/definitions.js";
import { validateToolArguments } from "../src/tools/validation.js";

test("library keeps local UUIDs separate from Google ids and syncs by preview", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "notebooklm-library-"));
  const libraryPath = path.join(directory, "library.json");
  try {
    const library = new NotebookLibrary(libraryPath);
    const added = library.addNotebook({
      url: "https://notebook.google.com/notebook/google-one",
      name: "Documentación",
      description: "Docs",
      topics: ["API"],
    });
    assert.match(added.id, /^[0-9a-f-]{36}$/i);
    assert.equal(added.google_notebook_id, "google-one");
    assert.equal(added.slug, "documentaci-n");
    assert.throws(
      () =>
        library.addNotebook({
          url: "https://notebook.google.com/notebook/google-one",
          name: "Duplicate",
          description: "",
          topics: [],
        }),
      /already registered/
    );

    const account = [
      {
        id: "google-one",
        name: "Renamed docs",
        url: "https://notebook.google.com/notebook/google-one",
        sourceCount: 3,
      },
      {
        id: "google-two",
        name: "新しいノート",
        url: "https://notebook.google.com/notebook/google-two",
        sourceCount: 1,
      },
    ];
    const preview = library.syncAccountNotebooks(account, false);
    assert.equal(preview.applied, false);
    assert.equal(preview.added.length, 1);
    assert.equal(preview.updated.length, 1);
    assert.equal(library.listNotebooks().length, 1);

    const applied = library.syncAccountNotebooks(account, true);
    assert.equal(applied.applied, true);
    assert.equal(library.listNotebooks().length, 2);
    assert.equal(
      library.listNotebooks().find((entry) => entry.google_notebook_id === "google-two")?.slug,
      "notebook"
    );
    const persisted = JSON.parse(await readFile(libraryPath, "utf8")) as { version: string };
    assert.equal(persisted.version, "2.0.0");
    const missingPreview = library.syncAccountNotebooks([account[1]], false);
    assert.equal(missingPreview.missing[0].google_notebook_id, "google-one");
    library.syncAccountNotebooks([account[1]], true);
    assert.equal(library.getNotebook(added.id)?.sync_status, "missing");
    const importedAgain = library.importAccountNotebook(account[1]);
    assert.equal(importedAgain.google_notebook_id, "google-two");
    assert.equal(library.listNotebooks().length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact jobs persist, reuse active work, and remain owner isolated", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "notebooklm-artifacts-"));
  const storePath = path.join(directory, "jobs.json");
  try {
    const store = new ArtifactStore(storePath);
    const first = store.create(
      "owner-a",
      "https://notebook.google.com/notebook/one",
      "audio_overview"
    );
    const reused = store.create(
      "owner-a",
      "https://notebook.google.com/notebook/one",
      "audio_overview"
    );
    assert.equal(reused.job_id, first.job_id);
    assert.equal(store.list("owner-b").length, 0);
    store.update(first.job_id, "owner-a", {
      status: "ready",
      artifact_id: "audio-overview:one",
    });
    const reloaded = new ArtifactStore(storePath);
    assert.equal(reloaded.get(first.job_id, "owner-a")?.status, "ready");
    assert.equal(reloaded.get(first.job_id, "owner-b"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source inventory reports stable ids, types, and indexing state", async () => {
  const { document } = parseHTML(`
    <div class="single-source-container" data-source-id="google-source-1">
      <span class="source-title">Guide.pdf</span><mat-icon>picture_as_pdf</mat-icon>
    </div>
    <div class="single-source-container" aria-busy="true">
      <span class="source-title">Demo video</span><a href="https://youtu.be/abc">video</a>
      <span class="source-status">Processing</span>
    </div>
    <div class="single-source-container">
      <span class="source-title">Demo video</span><a href="https://youtu.be/abc">video</a>
    </div>`);
  const page = {
    $$eval: async (selector: string, callback: Function, argument: unknown) =>
      callback(Array.from(document.querySelectorAll(selector)), argument),
  } as unknown as Page;
  const sources = await listSources(page);
  assert.equal(sources.length, 3);
  assert.equal(sources[0].source_id, "google-source-1");
  assert.equal(sources[0].type, "pdf");
  assert.match(sources[1].source_id, /^src_[0-9a-f]{16}$/);
  assert.equal(sources[1].type, "youtube");
  assert.equal(sources[1].status, "indexing");
  assert.notEqual(sources[1].source_id, sources[2].source_id);
});

test("source inventory distinguishes a changed UI from an empty notebook", async () => {
  const page = {
    $$eval: async () => [],
    locator: () => ({
      first: () => ({ isVisible: async () => false }),
    }),
  } as unknown as Page;
  await assert.rejects(listSources(page), /UI_CHANGED/);
});

test("citations expose structured compatibility fields", async () => {
  const { document } = parseHTML(`
    <div class="to-user-container"><div class="message-text-content">
      Answer <button class="citation-marker" data-source-id="source-42"><span aria-label="Citation: Manual.pdf">1</span></button>
    </div></div>
    <div class="paragraph"><span class="highlighted">See page 42 for details.</span></div>`);
  const previousDocument = (globalThis as { document?: Document }).document;
  (globalThis as { document?: Document }).document = document as unknown as Document;
  try {
    const page = {
      evaluate: async (callback: Function, argument: unknown) => callback(argument),
      keyboard: { press: async () => undefined },
      waitForTimeout: async () => undefined,
    } as unknown as Page;
    const result = await extractCitations(page, "Answer [1]", "json");
    assert.equal(result.citations[0].source_id, "source-42");
    assert.equal(result.citations[0].source_name, "Manual.pdf");
    assert.equal(result.citations[0].source_type, "pdf");
    assert.deepEqual(result.citations[0].location, { page: 42 });
    assert.equal(result.citations[0].extraction_status, "complete");
    assert.equal(result.citations[0].sourceName, "Manual.pdf");
  } finally {
    (globalThis as { document?: Document }).document = previousDocument;
  }
});

test("2.3 tool schemas validate YouTube, source lookup, and persistent artifacts", () => {
  const names = new Set(buildToolDefinitions().map((tool) => tool.name));
  for (const name of [
    "list_sources",
    "get_source",
    "get_source_status",
    "batch_add_sources",
    "sync_library",
    "import_account_notebook",
    "generate_artifact",
    "list_artifacts",
    "get_artifact_status",
    "download_artifact",
  ]) {
    assert.equal(names.has(name), true, `${name} should be registered`);
  }
  assert.equal(
    validateToolArguments("add_source", {
      type: "youtube",
      content: "https://www.youtube.com/watch?v=abc",
    }).type,
    "youtube"
  );
  assert.throws(
    () => validateToolArguments("add_source", { type: "youtube", content: "https://example.com" }),
    /YouTube URL/
  );
  assert.throws(() => validateToolArguments("get_source", {}), /source_id or name is required/);
});
