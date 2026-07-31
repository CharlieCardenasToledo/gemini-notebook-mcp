import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
  NOTEBOOK_UI_SELECTOR_VERSION,
  selectorCandidates,
  type SelectorGroupName,
} from "../src/notebooklm/selectors.js";
import { UiChangedError, classifyError } from "../src/errors.js";

async function fixture(name: string): Promise<Document> {
  const html = await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return parseHTML(html).document;
}

function matchesAny(document: Document, group: SelectorGroupName): boolean {
  return selectorCandidates(group).some((selector) => {
    try {
      return document.querySelector(selector) !== null;
    } catch {
      // Playwright-only pseudo selectors such as :text-is are expected here;
      // locale-independent or ARIA fallbacks must still match the fixture.
      return false;
    }
  });
}

test("versioned selector registry matches anonymized multilingual fixtures", async () => {
  assert.match(NOTEBOOK_UI_SELECTOR_VERSION, /^\d{4}\.\d{2}\.\d+$/);

  const auth = parseHTML(`
    <input id="identifierId" type="email">
    <button id="identifierNext">Next</button>
    <input name="Passwd" type="password">
    <button id="passwordNext">Next</button>
  `).document;
  assert.equal(matchesAny(auth, "auth.emailInput"), true);
  assert.equal(matchesAny(auth, "auth.identifierNext"), true);
  assert.equal(matchesAny(auth, "auth.passwordInput"), true);
  assert.equal(matchesAny(auth, "auth.passwordNext"), true);

  const chat = await fixture("notebook-chat-en.html");
  assert.equal(matchesAny(chat, "chat.queryInput"), true);
  assert.equal(matchesAny(chat, "chat.submitButton"), true);
  assert.equal(matchesAny(chat, "chat.answer"), true);
  assert.equal(matchesAny(chat, "citations.marker"), true);

  const sources = await fixture("notebook-sources-es.html");
  assert.equal(matchesAny(sources, "sources.addButton"), true);
  assert.equal(matchesAny(sources, "sources.dialog"), true);
  assert.equal(matchesAny(sources, "sources.contentInput"), true);

  const studio = await fixture("notebook-studio-de.html");
  assert.equal(matchesAny(studio, "studio.audioOverview"), true);
  assert.equal(matchesAny(studio, "studio.audioPlayer"), true);
  assert.equal(matchesAny(studio, "studio.audioMoreMenu"), true);

  const home = await fixture("notebook-home-ja.html");
  assert.equal(matchesAny(home, "notebooks.projectCard"), true);

  const emptyHome = await fixture("notebook-home-empty-en.html");
  assert.equal(matchesAny(emptyHome, "notebooks.emptyState"), true);
});

test("selector verification failures produce a structured UI_CHANGED error", () => {
  const error = new UiChangedError("sources.contentInput");
  assert.equal(error.selectorGroup, "sources.contentInput");
  assert.deepEqual(classifyError(error), {
    code: "UI_CHANGED",
    message: error.message,
    retryable: false,
    recommended_action: "Enable redacted diagnostics and update the affected selector group.",
  });
});
