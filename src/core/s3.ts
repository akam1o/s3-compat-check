import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import type { ResolvedConfig } from "./config.js";
import { tagOperation } from "./errors.js";
import { withTimeout } from "./timeout.js";

export type Send = S3Client["send"];
export type Credentials = NonNullable<S3ClientConfig["credentials"]>;

export function createS3Client(config: ResolvedConfig, credentials?: Credentials): S3Client {
  return new S3Client({
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
      connectionTimeout: config.timeoutMs,
      requestTimeout: config.timeoutMs,
    },
  });
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
    try {
      const out = await withTimeout(operation, timeoutMs, parent, (abortSignal) =>
        client.send(command as Parameters<Send>[0], { abortSignal }),
      );
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
