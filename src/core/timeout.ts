import { DeadlineExceededError, OperationTimeoutError, RunAbortedError } from "./errors.js";

export interface OperationSignal {
  signal: AbortSignal;
  timedOut(): boolean;
}

/** A signal that fires after `timeoutMs` or when `parent` aborts. */
export function operationSignal(timeoutMs: number, parent?: AbortSignal): OperationSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
  return { signal, timedOut: () => timeout.aborted && !(parent?.aborted ?? false) };
}

/** Error to throw when `parent` is aborted. A timeout reason means a deadline. */
function parentAbortError(parent: AbortSignal, operation: string): Error {
  const reason = parent.reason as { name?: unknown } | undefined;
  return reason?.name === "TimeoutError"
    ? new DeadlineExceededError(operation)
    : new RunAbortedError(operation);
}

/**
 * Run `fn` with a per-operation timeout. Errors caused by the timeout or by
 * the parent signal are normalized to `OperationTimeoutError`,
 * `DeadlineExceededError` (parent was a deadline) or `RunAbortedError`.
 */
export async function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  parent: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
  /** Reuse an existing deadline (e.g. a request and its response body). */
  existing?: OperationSignal,
): Promise<T> {
  if (parent?.aborted) throw parentAbortError(parent, operation);
  const op = existing ?? operationSignal(timeoutMs, parent);
  if (op.timedOut()) throw new OperationTimeoutError(operation, timeoutMs);
  const abortError = () =>
    op.timedOut()
      ? new OperationTimeoutError(operation, timeoutMs)
      : parentAbortError(parent as AbortSignal, operation);
  let onAbort: (() => void) | undefined;
  // Guarantees settlement even if `fn` ignores the signal.
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    op.signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    return await Promise.race([fn(op.signal), aborted]);
  } catch (error) {
    if (op.signal.aborted) throw abortError();
    throw error;
  } finally {
    if (onAbort) op.signal.removeEventListener("abort", onAbort);
  }
}
