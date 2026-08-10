import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { NotebookLibrary } from "../src/library/notebook-library.js";

async function createEmptyLibrary() {
  const directory = await mkdtemp(path.join(tmpdir(), "notebook-library-update-"));
  const libraryPath = path.join(directory, "library.json");

  await writeFile(
    libraryPath,
    JSON.stringify(
      {
        notebooks: [],
        active_notebook_id: null,
        last_modified: new Date(0).toISOString(),
        version: "2.0.0",
      },
      null,
      2
    ),
    "utf8"
  );

  return { directory, libraryPath, library: new NotebookLibrary(libraryPath) };
}

function addInput(url: string, name: string) {
  return {
    url,
    name,
    description: "Test",
    topics: ["test"],
  };
}

test("updating notebook URL refreshes Google identity and invalidates stale sync metadata", async () => {
  const { directory, libraryPath, library } = await createEmptyLibrary();

  try {
    const added = library.addNotebook(
      addInput("https://notebook.google.com/notebook/google-one", "One")
    );

    library.syncAccountNotebooks(
      [
        {
          id: "google-one",
          name: "One",
          url: "https://notebook.google.com/notebook/google-one",
          sourceCount: 7,
        },
      ],
      true
    );

    const before = library.getNotebook(added.id)!;
    assert.equal(before.google_notebook_id, "google-one");
    assert.equal(before.source_count, 7);
    assert.equal(before.sync_status, "available");
    assert.ok(before.last_synced_at);

    const changed = library.updateNotebook({
      id: added.id,
      url: "https://notebook.google.com/notebook/google-two",
    });

    assert.equal(changed.google_notebook_id, "google-two");
    assert.match(changed.url, /\/notebook\/google-two/);
    assert.equal(changed.source_count, null);
    assert.equal(changed.sync_status, "unknown");
    assert.equal(changed.last_synced_at, undefined);

    const reloaded = new NotebookLibrary(libraryPath).getNotebook(added.id)!;
    assert.equal(reloaded.google_notebook_id, "google-two");
    assert.equal(reloaded.source_count, null);
    assert.equal(reloaded.sync_status, "unknown");
    assert.equal(reloaded.last_synced_at, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("updating notebook URL rejects another registered Google notebook identity", async () => {
  const { directory, library } = await createEmptyLibrary();

  try {
    const first = library.addNotebook(
      addInput("https://notebook.google.com/notebook/google-one", "One")
    );
    const second = library.addNotebook(
      addInput("https://notebook.google.com/notebook/google-two", "Two")
    );

    assert.throws(
      () =>
        library.updateNotebook({
          id: first.id,
          url: "https://notebook.google.com/notebook/google-two?authuser=3",
        }),
      new RegExp(`Notebook is already registered: ${second.id}`)
    );

    const firstAfter = library.getNotebook(first.id)!;
    assert.equal(firstAfter.google_notebook_id, "google-one");
    assert.match(firstAfter.url, /\/notebook\/google-one/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("updating notebook URL for the same Google identity preserves sync metadata", async () => {
  const { directory, library } = await createEmptyLibrary();

  try {
    const added = library.addNotebook(
      addInput("https://notebook.google.com/notebook/google-one", "One")
    );
    library.syncAccountNotebooks(
      [
        {
          id: "google-one",
          name: "One",
          url: "https://notebook.google.com/notebook/google-one",
          sourceCount: 5,
        },
      ],
      true
    );

    const before = library.getNotebook(added.id)!;
    const changed = library.updateNotebook({
      id: added.id,
      url: "https://notebooklm.google.com/notebook/google-one?authuser=1",
    });

    assert.equal(changed.google_notebook_id, "google-one");
    assert.equal(changed.source_count, 5);
    assert.equal(changed.sync_status, "available");
    assert.equal(changed.last_synced_at, before.last_synced_at);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
