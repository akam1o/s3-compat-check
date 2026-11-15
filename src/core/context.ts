import { randomBytes } from "node:crypto";
import { addAbortSignal, type Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { tagOperation } from "./errors.js";
import { bodyDeadline, type Send } from "./s3.js";
import { withTimeout } from "./timeout.js";
import type { ResourceTracker } from "./tracker.js";

/** Everything a check may use. Checks must not touch keys outside `prefix`. */
export interface CheckContext {
  readonly checkId: string;
  readonly bucket: string;
  readonly region: string;
  /** Unique prefix for this check, below the run prefix. */
  readonly prefix: string;
  readonly timeoutMs: number;
  /** Aborted when the run is interrupted. */
  readonly signal: AbortSignal;
  /** Raw client, for the presigner only. Use `send` for requests. */
  readonly client: S3Client;
  /** `client.send` with a per-operation timeout and no retries. */
  readonly send: Send;
  /** A tracked key that will be removed during cleanup. */
  key(name: string): string;
  /** A key that is never written (for negative tests). */
  unusedKey(name: string): string;
  /** Record the version id returned by a write, for cleanup on versioned buckets. */
  recordWrite(key: string, versionId: string | undefined): void;
  /** Record that the check itself removed an object. */
  recordDelete(key: string, deleteMarkerVersionId: string | undefined): void;
  trackUpload(key: string, uploadId: string): void;
  untrackUpload(uploadId: string): void;
  /** Read a streaming body completely, bounded by the operation timeout. */
  readBody(body: unknown, operation: string): Promise<Buffer>;
  /** Stream a body through `onChunk` without buffering it. Returns the byte count. */
  consumeBody(body: unknown, operation: string, onChunk: (chunk: Buffer) => void): Promise<number>;
  /** `fetch` with the operation timeout applied. */
  fetch(
    url: string,
    init: RequestInit,
    operation: string,
  ): Promise<{ response: Response; body: Buffer }>;
  /** Add an observation to the check result. Must not contain secrets. */
  note(message: string): void;
  /** Verbose diagnostic log (not part of the result). */
  log(message: string): void;
}

export interface ContextOptions {
  checkId: string;
  bucket: string;
  region: string;
  runPrefix: string;
  timeoutMs: number;
  signal: AbortSignal;
  client: S3Client;
  send: Send;
  tracker: ResourceTracker;
  logger?: (message: string) => void;
}

function toReadable(body: unknown): Readable {
  if (
    body &&
    typeof body === "object" &&
    typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function" &&
    typeof (body as { destroy?: unknown }).destroy === "function"
  ) {
    return body as Readable;
  }
  throw new Error("Response has no readable body");
}

export function createCheckContext(options: ContextOptions): CheckContext & { notes: string[] } {
  const prefix = `${options.runPrefix}${options.checkId}/`;
  const notes: string[] = [];
  const log = (message: string) => options.logger?.(`[${options.checkId}] ${message}`);

  const consumeBody = async (
    body: unknown,
    operation: string,
    onChunk: (chunk: Buffer) => void,
  ): Promise<number> => {
    const stream = toReadable(body);
    // Bodies from `send` share the request's deadline: headers + body together
    // must finish within the operation timeout.
    const deadline = bodyDeadline(body);
    try {
      return await withTimeout(
        operation,
        deadline?.timeoutMs ?? options.timeoutMs,
        options.signal,
        async (signal) => {
          addAbortSignal(signal, stream);
          let total = 0;
          for await (const chunk of stream) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            total += buf.length;
            onChunk(buf);
          }
          return total;
        },
        deadline?.op,
      );
    } catch (error) {
      stream.destroy();
      tagOperation(error, operation);
      throw error;
    }
  };

  return {
    notes,
    checkId: options.checkId,
    bucket: options.bucket,
    region: options.region,
    prefix,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    client: options.client,
    send: options.send,
    key(name) {
      const key = `${prefix}${name}`;
      options.tracker.addObject(key, options.checkId);
      return key;
    },
    unusedKey(name) {
      return `${prefix}${name}-${randomBytes(6).toString("hex")}`;
    },
    recordWrite(key, versionId) {
      options.tracker.addVersion(key, versionId);
    },
    recordDelete(key, deleteMarkerVersionId) {
      if (deleteMarkerVersionId) {
        // Versioned bucket: the delete created a marker that must also be removed.
        options.tracker.addVersion(key, deleteMarkerVersionId);
      } else if (!options.tracker.versioningObserved) {
        options.tracker.markDeleted(key);
      }
    },
    trackUpload(key, uploadId) {
      options.tracker.addUpload(key, uploadId, options.checkId);
    },
    untrackUpload(uploadId) {
      options.tracker.removeUpload(uploadId);
    },
    async readBody(body, operation) {
      const chunks: Buffer[] = [];
      await consumeBody(body, operation, (c) => chunks.push(c));
      return Buffer.concat(chunks);
    },
    consumeBody,
    async fetch(url, init, operation) {
      try {
        return await withTimeout(operation, options.timeoutMs, options.signal, async (signal) => {
          const response = await fetch(url, { ...init, signal });
          const body = Buffer.from(await response.arrayBuffer());
          return { response, body };
        });
      } catch (error) {
        tagOperation(error, operation);
        throw error;
      }
    },
    note(message) {
      notes.push(message);
      log(message);
    },
    log,
  };
}
