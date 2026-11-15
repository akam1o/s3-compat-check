import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import type { ResolvedConfig } from "./config.js";
import { tagOperation } from "./errors.js";
import { operationSignal, withTimeout, type OperationSignal } from "./timeout.js";

export type Send = S3Client["send"];
export type Credentials = NonNullable<S3ClientConfig["credentials"]>;

/** SDK diagnostics are discarded: the library must not write to stdout/stderr. */
const SILENT_LOGGER = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Socket-level timeouts are only a backstop. Our own per-operation timers
 * (which also cover body streaming) must fire first so that timeouts are
 * reported as timeouts rather than as connection resets.
 */
const HANDLER_TIMEOUT_SLACK_MS = 5_000;

export function createS3Client(config: ResolvedConfig, credentials?: Credentials): S3Client {
  return new S3Client({
    logger: SILENT_LOGGER,
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.addressingStyle === "path",
    ...(credentials ? { credentials } : {}),
    // A smoke test must report what the server actually did: no retries.
    maxAttempts: 1,
    // Only send/validate checksums when the API requires it, so that checks
    // that do not test checksums are not affected by checksum support.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      connectionTimeout: config.timeoutMs + HANDLER_TIMEOUT_SLACK_MS,
      requestTimeout: config.timeoutMs + HANDLER_TIMEOUT_SLACK_MS,
    },
  });
}

export interface BodyDeadline {
  op: OperationSignal;
  operation: string;
  timeoutMs: number;
  parent: AbortSignal | undefined;
}

const bodyDeadlines = new WeakMap<object, BodyDeadline>();

/** The deadline of the request that produced `body`, if it came from `timedSend`. */
export function bodyDeadline(body: unknown): BodyDeadline | undefined {
  return body && typeof body === "object" ? bodyDeadlines.get(body) : undefined;
}

export function operationName(command: unknown): string {
  const name = (command as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" ? name.replace(/Command$/, "") : "S3Request";
}

/**
 * Wrap `client.send` so that every call gets its own timeout, honours the
 * parent signal and tags errors with the operation name.
 */
export function timedSend(
  client: Pick<S3Client, "send">,
  timeoutMs: number,
  parent: AbortSignal | undefined,
  onCall?: (operation: string, durationMs: number, error?: unknown) => void,
): Send {
  const send = async (command: unknown) => {
    const operation = operationName(command);
    const started = performance.now();
    const op = operationSignal(timeoutMs, parent);
    try {
      const out = await withTimeout(
        operation,
        timeoutMs,
        parent,
        (abortSignal) => client.send(command as Parameters<Send>[0], { abortSignal }),
        op,
      );
      // The SDK keeps listening to this signal while the body streams, so the
      // body must be read under the same deadline (see bodyDeadline).
      const body = (out as { Body?: unknown }).Body;
      if (body && typeof body === "object") {
        bodyDeadlines.set(body, { op, operation, timeoutMs, parent });
      }
      onCall?.(operation, performance.now() - started);
      return out;
    } catch (error) {
      tagOperation(error, operation);
      onCall?.(operation, performance.now() - started, error);
      throw error;
    }
  };
  return send as unknown as Send;
}
