import assert from "node:assert/strict";
import test from "node:test";
import {
  findCompletedTurnAnswer,
  isPlaceholder,
  isThinkingStep,
  normalizeChatText,
  sanitizeAnswer,
  type ChatMessageSnapshot,
} from "../src/notebooklm/chat.js";

const THINKING_SUMMARIES = [
  "Clarifying Initial Requests\nI'm currently focused on structuring a concise explanation. My immediate task is to outline the key elements.",
  "Refining the Focus\nI'm now zeroing in on the common thread. My current aim is to express this concisely.",
  "Defining the Summary Scope\nMy next task is to distil the sources into a two-sentence summary.",
];

const GROUNDED_ANSWERS = [
  "Understanding the Five Moves\nThe framework defines five core moves that a system designer applies.",
  "The document explains that the system will retry failed steps automatically.",
  "Yes. The sources confirm that automated loops reduce manual prompting overhead [1].",
];

test("normalizes rendered whitespace before correlating a chat turn", () => {
  assert.equal(
    normalizeChatText("  ¿Qué explica\n   CREATE TABLE?  "),
    "¿Qué explica CREATE TABLE?"
  );
});

test("recognizes Gemini extended-thinking summaries without rejecting grounded answers", () => {
  for (const summary of THINKING_SUMMARIES) {
    assert.equal(isThinkingStep(summary), true);
    assert.equal(isPlaceholder(summary), true);
  }
  for (const answer of GROUNDED_ANSWERS) {
    assert.equal(isThinkingStep(answer), false);
    assert.equal(isPlaceholder(answer), false);
  }
});

test("does not return an older answer or Gemini reasoning for a new question", () => {
  const messages: ChatMessageSnapshot[] = [
    { role: "user", text: "Explica herencia EER" },
    { role: "assistant", text: "Defining Key Concepts...", complete: true },
    { role: "user", text: "Explica CREATE TABLE" },
    {
      role: "assistant",
      text: "Deciphering the Intent. I'm zeroing in on the request...",
      complete: false,
    },
  ];

  assert.equal(findCompletedTurnAnswer(messages, "Explica CREATE TABLE"), null);
});

test("returns only the completed answer paired with the exact user turn", () => {
  const messages: ChatMessageSnapshot[] = [
    { role: "user", text: "Explica herencia EER" },
    { role: "assistant", text: "Respuesta EER", complete: true },
    { role: "user", text: "Explica\nCREATE TABLE" },
    {
      role: "assistant",
      text: "CREATE TABLE define una tabla y sus restricciones.",
      complete: true,
    },
  ];

  assert.equal(
    findCompletedTurnAnswer(messages, "Explica CREATE TABLE"),
    "CREATE TABLE define una tabla y sus restricciones."
  );
});

test("correlates a rendered turn despite quote, accent, or minor typing differences", () => {
  const messages: ChatMessageSnapshot[] = [
    {
      role: "user",
      text: "Primera prueba MCP: responde unicamente con PRIMERA.",
    },
    { role: "assistant", text: "PRIMERA.", complete: true },
  ];

  assert.equal(
    findCompletedTurnAnswer(messages, '"Primera prueba MCP responde únicamente con PRIMERA"'),
    "PRIMERA."
  );
});

test("uses the newest occurrence when the same question is submitted twice", () => {
  const messages: ChatMessageSnapshot[] = [
    { role: "user", text: "Lista las fuentes" },
    { role: "assistant", text: "Respuesta anterior", complete: true },
    { role: "user", text: "Lista las fuentes" },
    { role: "assistant", text: "Respuesta actual", complete: true },
  ];

  assert.equal(findCompletedTurnAnswer(messages, "Lista las fuentes"), "Respuesta actual");
});

test("sanitizes UI controls while preserving paragraph spacing", () => {
  assert.equal(
    sanitizeAnswer("Primer párrafo.\n\nSegundo párrafo.\nmore_vert\n\n- Elemento\ncopy_all"),
    "Primer párrafo.\n\nSegundo párrafo.\n\n- Elemento"
  );
});
