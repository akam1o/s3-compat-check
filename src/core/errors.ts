/**
 * Error types and classification.
 *
 * Errors coming from the AWS SDK are never serialized as-is: they may carry the
 * raw HTTP response, request headers or resolved client configuration. Instead
 * they are reduced to a small, plain `CheckError` object.
 */

export type ErrorKind =
  "assertion" | "http" | "network" | "timeout" | "aborted" | "credentials" | "skipped" | "unknown";

export interface CheckError {
  kind: ErrorKind;
  message: string;
  /** S3 operation (or HTTP step) that failed, e.g. "PutObject". */
  operation?: string;
  /** S3 error code, e.g. "NoSuchKey". */
  code?: string;
  httpStatus?: number;
  requestId?: string;
  /** For assertion failures: what was expected and what was received. */
  expected?: string;
  actual?: string;
}

/** Invalid CLI arguments or configuration. Maps to exit code 2. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * The environment prevents running checks at all (cannot connect, no
 * credentials, bucket not accessible). Maps to exit code 3.
 */
export class EnvironmentError extends Error {
  override readonly name = "EnvironmentError";
  readonly detail: CheckError;

  constructor(message: string, detail?: CheckError) {
    super(message);
    this.detail = detail ?? { kind: "unknown", message };
  }
}

/** A check observed a response that differs from the expected S3 behavior. */
export class AssertionFailure extends Error {
  override readonly name = "AssertionFailure";
  readonly expected?: string;
  readonly actual?: string;
  readonly operation?: string;

  constructor(
    message: string,
    options: { expected?: unknown; actual?: unknown; operation?: string } = {},
  ) {
    super(message);
    if ("expected" in options) this.expected = describeValue(options.expected);
    if ("actual" in options) this.actual = describeValue(options.actual);
    if (options.operation !== undefined) this.operation = options.operation;
  }
}

/** An optional S3 feature is not implemented by the target. */
export class UnsupportedFeature extends Error {
  override readonly name = "UnsupportedFeature";
  readonly detail?: CheckError;

  constructor(message: string, detail?: CheckError) {
    super(message);
    this.detail = detail;
  }
}

/** An unexpected HTTP response obtained outside the SDK (e.g. via fetch). */
export class ResponseError extends Error {
  override readonly name = "ResponseError";
  constructor(
    message: string,
    readonly detail: CheckError,
  ) {
    super(message);
  }
}

/** The check could not be meaningfully executed in this environment. */
export class SkipCheck extends Error {
  override readonly name = "SkipCheck";
}

export class OperationTimeoutError extends Error {
  override readonly name = "OperationTimeoutError";
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs} ms`);
  }
}

export class DeadlineExceededError extends Error {
  override readonly name = "DeadlineExceededError";
  constructor(readonly operation: string) {
    super(`${operation} aborted: cleanup deadline exceeded`);
  }
}

export class RunAbortedError extends Error {
  override readonly name = "RunAbortedError";
  constructor(readonly operation?: string) {
    super(operation ? `${operation} aborted because the run was interrupted` : "Run aborted");
  }
}

const operationTags = new WeakMap<object, string>();

/** Remember which operation produced an error without mutating it. */
export function tagOperation(error: unknown, operation: string): void {
  if (typeof error === "object" && error !== null && !operationTags.has(error)) {
    operationTags.set(error, operation);
  }
}

export function operationOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) return operationTags.get(error);
  return undefined;
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNABORTED",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

interface SdkLikeError {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  Code?: unknown;
  cause?: unknown;
  $metadata?: { httpStatusCode?: unknown; requestId?: unknown };
  $fault?: unknown;
}

function asRecord(value: unknown): SdkLikeError | undefined {
  return typeof value === "object" && value !== null ? (value as SdkLikeError) : undefined;
}

function networkCode(error: unknown, depth = 0): string | undefined {
  const e = asRecord(error);
  if (!e || depth > 4) return undefined;
  if (typeof e.code === "string" && NETWORK_ERROR_CODES.has(e.code)) return e.code;
  return networkCode(e.cause, depth + 1);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** HTTP status and S3 error code from an SDK service exception, if any. */
export function httpErrorInfo(
  error: unknown,
): { httpStatus: number; code?: string; requestId?: string } | undefined {
  const e = asRecord(error);
  const status = e?.$metadata?.httpStatusCode;
  if (!e || typeof status !== "number") return undefined;
  const code = stringOf(e.Code) ?? stringOf(e.name);
  const requestId = stringOf(e.$metadata?.requestId);
  // The SDK uses placeholder names when the response carries no error code.
  const meaningful = code && !["Error", "Unknown", "UnknownError"].includes(code);
  return {
    httpStatus: status,
    ...(meaningful ? { code } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

/** Reduce any thrown value to a plain, serializable `CheckError`. */
export function classifyError(error: unknown): CheckError {
  const operation =
    operationOf(error) ??
    (error instanceof AssertionFailure ||
    error instanceof OperationTimeoutError ||
    error instanceof DeadlineExceededError ||
    error instanceof RunAbortedError
      ? error.operation
      : undefined);
  const withOp = (e: CheckError): CheckError => (operation ? { ...e, operation } : e);

  if (error instanceof AssertionFailure) {
    return withOp({
      kind: "assertion",
      message: error.message,
      ...(error.expected !== undefined ? { expected: error.expected } : {}),
      ...(error.actual !== undefined ? { actual: error.actual } : {}),
    });
  }
  if (error instanceof OperationTimeoutError || error instanceof DeadlineExceededError) {
    return withOp({ kind: "timeout", message: error.message });
  }
  if (error instanceof RunAbortedError) {
    return withOp({ kind: "aborted", message: error.message });
  }
  if (error instanceof ResponseError) {
    return withOp({ ...error.detail });
  }
  if ((error instanceof UnsupportedFeature || error instanceof EnvironmentError) && error.detail) {
    return withOp({ ...error.detail, message: error.message });
  }

  const e = asRecord(error);
  const message = stringOf(e?.message) ?? String(error);
  const http = httpErrorInfo(error);
  if (http) {
    // The SDK reports "UnknownError" when the response has no body (HEAD, 403 ...).
    const cleanMessage = message === "UnknownError" ? `HTTP ${http.httpStatus}` : message;
    return withOp({ kind: "http", message: cleanMessage, ...http });
  }

  const net = networkCode(error);
  if (net) return withOp({ kind: "network", code: net, message });

  const name = stringOf(e?.name);
  if (name === "TimeoutError" || name === "RequestTimeout") {
    return withOp({ kind: "timeout", message });
  }
  if (name === "AbortError") {
    return withOp({ kind: "aborted", message });
  }
  if (name === "CredentialsProviderError") {
    return withOp({ kind: "credentials", message });
  }
  return withOp({ kind: "unknown", message, ...(name && name !== "Error" ? { code: name } : {}) });
}

export function describeValue(value: unknown): string {
  if (value === undefined) return "(missing)";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
