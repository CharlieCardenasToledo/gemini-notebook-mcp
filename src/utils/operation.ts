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
  const interruptions: Promise<never>[] = [];

  if (signal) {
    interruptions.push(
      new Promise<never>((_resolve, reject) => {
        abortListener = () => {
          void Promise.resolve(onInterrupt?.()).finally(() => {
            reject(new OperationCancelledError());
          });
        };
        signal.addEventListener("abort", abortListener, { once: true });
      })
    );
  }

  if (timeoutMs !== undefined) {
    interruptions.push(
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void Promise.resolve(onInterrupt?.()).finally(() => {
            reject(new Error(`TIMEOUT: ${operationName} exceeded ${timeoutMs}ms`));
          });
        }, timeoutMs);
      })
    );
  }

  try {
    return await Promise.race([operation(), ...interruptions]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}
