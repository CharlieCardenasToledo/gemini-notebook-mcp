import assert from "node:assert/strict";
import test from "node:test";
import { parseHttpEnvironmentOptions, parseTransportOptions } from "../src/transport/options.js";

test("HTTP numeric environment options reject partially numeric values", () => {
  const options = parseHttpEnvironmentOptions({
    NOTEBOOKLM_HTTP_MAX_BODY_BYTES: "2097152bytes",
    NOTEBOOKLM_HTTP_MAX_SESSIONS: "64sessions",
  });
  assert.equal(options.maxBodyBytes, 1024 * 1024);
  assert.equal(options.maxSessions, 32);
});
test("HTTP numeric environment options accept trimmed decimal integers", () => {
  const options = parseHttpEnvironmentOptions({
    NOTEBOOKLM_HTTP_MAX_BODY_BYTES: " 2097152 ",
    NOTEBOOKLM_HTTP_MAX_SESSIONS: " 64 ",
  });
  assert.equal(options.maxBodyBytes, 2097152);
  assert.equal(options.maxSessions, 64);
});
test("HTTP environment port falls back when the value is only partially numeric", () => {
  assert.deepEqual(
    parseTransportOptions([], { NOTEBOOKLM_TRANSPORT: "http", NOTEBOOKLM_PORT: "4001junk" }),
    { kind: "http", port: 3000 }
  );
});
test("HTTP CLI port rejects partially numeric values", () => {
  for (const args of [
    ["--transport=http", "--port", "4001junk"],
    ["--transport=http", "--port=4001junk"],
  ])
    assert.throws(() => parseTransportOptions(args, {}), /Invalid HTTP port/);
});
test("HTTP CLI port accepts a complete decimal value", () => {
  assert.deepEqual(parseTransportOptions(["--transport=http", "--port=4001"], {}), {
    kind: "http",
    port: 4001,
  });
});
test("HTTP CLI port rejects zero and out-of-range values", () => {
  for (const value of ["0", "65536"])
    assert.throws(
      () => parseTransportOptions(["--transport=http", `--port=${value}`], {}),
      /Invalid HTTP port/
    );
});
test("stdio ignores an invalid HTTP-only port override", () => {
  assert.deepEqual(parseTransportOptions(["--port=garbage"], {}), { kind: "stdio" });
});
test("last HTTP CLI port override wins", () => {
  assert.equal(
    parseTransportOptions(["--transport=http", "--port=garbage", "--port=4001"], {}).port,
    4001
  );
  assert.throws(
    () => parseTransportOptions(["--transport=http", "--port=4001", "--port=garbage"], {}),
    /Invalid HTTP port/
  );
});
