import test from "node:test";
import assert from "node:assert/strict";
import { cleanAnswer, truncateAnswer } from "../src/tools/handlers.js";

test("cleanAnswer strips Thoughts prefix, closing invitation and emojis", () => {
  const raw = "Thoughts\n\nUna pila es LIFO 🙂.\n\n¿Te gustaría ver un ejemplo?";
  assert.equal(cleanAnswer(raw), "Una pila es LIFO .");
});

test("cleanAnswer keeps regular answers intact", () => {
  assert.equal(cleanAnswer("Respuesta simple."), "Respuesta simple.");
});

test("truncateAnswer cuts at a sentence boundary when possible", () => {
  const text = "Primera frase larga que ocupa espacio. Segunda frase que se corta aquí";
  assert.equal(truncateAnswer(text, 45), "Primera frase larga que ocupa espacio.…");
  assert.equal(truncateAnswer("corto", 100), "corto");
});
