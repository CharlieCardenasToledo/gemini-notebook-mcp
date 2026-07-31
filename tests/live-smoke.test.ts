import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLiveFailure,
  extractToolPayload,
  redactLiveDiagnostic,
} from "../src/utils/live-smoke.js";

test("live smoke classifies environmental prerequisites as skips", () => {
  assert.equal(
    classifyLiveFailure({ error_details: { code: "AUTH_REQUIRED" }, error: "sign in" }),
    "skip"
  );
  assert.equal(classifyLiveFailure({ error: "Chrome profile is already in use" }), "skip");
  assert.equal(
    classifyLiveFailure({ error_details: { code: "UI_CHANGED" }, error: "selector missing" }),
    "fail"
  );
});

test("live smoke diagnostics redact user and environment identifiers", () => {
  const rendered = redactLiveDiagnostic(
    "Open https://notebook.google.com/notebook/abc from C:\\Users\\person\\profile or /home/person/profile for person@example.com id 123e4567-e89b-42d3-a456-426614174000"
  );
  assert.doesNotMatch(rendered, /notebook\.google|Users|\/home\/person|person@example|123e4567/);
  assert.match(rendered, /redacted-url/);
  assert.match(rendered, /redacted-path/);
  assert.match(rendered, /redacted-email/);
  assert.match(rendered, /redacted-id/);
});

test("live smoke prefers structured content and supports JSON text fallback", () => {
  assert.deepEqual(
    extractToolPayload({ structuredContent: { success: true, data: { count: 2 } } }),
    { success: true, data: { count: 2 } }
  );
  assert.deepEqual(extractToolPayload({ content: [{ type: "text", text: '{"success":true}' }] }), {
    success: true,
  });
  assert.throws(() => extractToolPayload({ content: [] }), /did not contain/);
});
