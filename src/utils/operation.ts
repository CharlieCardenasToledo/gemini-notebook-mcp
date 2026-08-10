import { OperationCancelledError } from "../errors.js";

export interface OperationBoundaryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onInterrupt?: () => void | Promise<void>;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OperationCancelledError();
  }
}

export async function runWithOperationBoundary<T>(
  operationName: string,
  operation: () => Promise<T>,
  options: OperationBoundaryOptions = {}
): Promise<T> {
  const { signal, timeoutMs, onInterrupt } = options;
  throwIfAborted(signal);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let rejectInterruption: ((reason?: unknown) => void) | undefined;
  let interruptionStarted = false;

  const interruption =
    signal || timeoutMs !== undefined
      ? new Promise<never>((_resolve, reject) => {
          rejectInterruption = reject;
        })
      : undefined;

  const interrupt = (error: Error): void => {
    if (interruptionStarted) {
      return;
    }

    interruptionStarted = true;

    void (async () => {
      try {
        await onInterrupt?.();
      } catch {
        // Interruption cleanup is best-effort. Preserve the cancellation or
        // timeout that actually interrupted the operation.
      } finally {
        rejectInterruption?.(error);
      }
    })();
  };

  if (signal) {
    abortListener = () => {
      interrupt(new OperationCancelledError());
    };

    signal.addEventListener("abort", abortListener, { once: true });

    if (signal.aborted) {
      abortListener();
    }
  }

  if (timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      interrupt(new Error(`TIMEOUT: ${operationName} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  }

  try {
    const operationPromise = operation();

    return await (interruption ? Promise.race([operationPromise, interruption]) : operationPromise);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}
