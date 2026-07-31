import assert from "node:assert/strict";
import test from "node:test";
import { OperationCancelledError } from "../src/errors.js";
import { runWithOperationBoundary, throwIfAborted } from "../src/utils/operation.js";

test("operation boundary propagates client cancellation and interrupts work", async () => {
  const controller = new AbortController();
  let interrupted = false;
  const result = runWithOperationBoundary(
    "cancel-test",
    () => new Promise<string>(() => undefined),
    {
      signal: controller.signal,
      onInterrupt: () => {
        interrupted = true;
      },
    }
  );

  controller.abort();
  await assert.rejects(result, OperationCancelledError);
  assert.equal(interrupted, true);
  assert.throws(() => throwIfAborted(controller.signal), OperationCancelledError);
});

test("operation boundary enforces one total timeout", async () => {
  let interrupted = false;
  await assert.rejects(
    runWithOperationBoundary("timeout-test", () => new Promise<string>(() => undefined), {
      timeoutMs: 20,
      onInterrupt: () => {
        interrupted = true;
      },
    }),
    /TIMEOUT: timeout-test exceeded 20ms/
  );
  assert.equal(interrupted, true);
});
