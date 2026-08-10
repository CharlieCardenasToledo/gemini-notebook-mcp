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

test("operation boundary interrupts only once when cancellation and timeout overlap", async () => {
  const controller = new AbortController();
  let interruptCalls = 0;

  let releaseInterrupt!: () => void;
  const interruptGate = new Promise<void>((resolve) => {
    releaseInterrupt = resolve;
  });

  const result = runWithOperationBoundary(
    "overlap-test",
    () => new Promise<string>(() => undefined),
    {
      signal: controller.signal,
      timeoutMs: 20,
      onInterrupt: async () => {
        interruptCalls++;
        await interruptGate;
      },
    }
  );

  controller.abort();

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });

  assert.equal(
    interruptCalls,
    1,
    "onInterrupt must run only once even if the timeout fires while cancellation cleanup is pending"
  );

  releaseInterrupt();

  await assert.rejects(result, OperationCancelledError);

  assert.equal(interruptCalls, 1);
});
