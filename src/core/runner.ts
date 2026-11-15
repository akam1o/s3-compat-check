import { HeadBucketCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { ALL_CHECKS, type Check } from "../checks/index.js";
import { CleanupStats, cleanupTracked, findRemaining, sweepRunPrefix } from "./cleanup.js";
import { resolveConfig, type ConfigInput, type ResolvedConfig } from "./config.js";
import { createCheckContext } from "./context.js";
import {
  EnvironmentError,
  RunAbortedError,
  SkipCheck,
  UnsupportedFeature,
  classifyError,
  type CheckError,
} from "./errors.js";
import { mapWithConcurrency } from "./pool.js";
import { createRedactor, type Redactor } from "./redact.js";
import {
  isRunSuccessful,
  summarize,
  type CheckResult,
  type CheckStatus,
  type CleanupReport,
  type RunReport,
} from "./result.js";
import { createS3Client, timedSend, type Credentials, type Send } from "./s3.js";
import { ResourceTracker } from "./tracker.js";
import { withTimeout } from "./timeout.js";
import { TOOL_NAME, TOOL_VERSION, awsSdkVersion } from "./version.js";

export interface RunOptions extends ConfigInput {
  bucket: string;
  /** Explicit credentials. Defaults to the AWS SDK credential provider chain. */
  credentials?: Credentials;
  /** Abort the run. Cleanup still runs, bounded by its own timeout. */
  signal?: AbortSignal;
  /** Receives verbose diagnostics (already redacted). Nothing is logged by default. */
  logger?: (message: string) => unknown;
  /**
   * Called as each check finishes (in completion order). Not awaited; errors
   * and rejections are ignored and never affect the run or its cleanup.
   */
  onCheckComplete?: (result: CheckResult) => unknown;
  /** Environment used for defaults and redaction. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Test seams; not part of the public API. */
export interface RunDependencies {
  checks?: readonly Check[];
  client?: Pick<S3Client, "send"> & Partial<Pick<S3Client, "config" | "destroy">>;
}

/** Operations that may create an object version even if their response is lost. */
const WRITE_OPERATIONS = new Set([
  "PutObject",
  "CompleteMultipartUpload",
  "DeleteObject",
  "CopyObject",
]);

/** Metadata of every available check, in execution/display order. */
export function listChecks(): Array<Pick<Check, "id" | "name" | "description" | "required">> {
  return ALL_CHECKS.map(({ id, name, description, required }) => ({
    id,
    name,
    description,
    required,
  }));
}

function environmentMessage(bucket: string, detail: CheckError): string {
  switch (detail.kind) {
    case "network":
      return `Cannot connect to the endpoint (${detail.code ?? "network error"})`;
    case "timeout":
      return detail.operation === "ResolveCredentials"
        ? detail.message
        : `Timed out while connecting to the endpoint`;
    case "credentials":
      return `Could not resolve AWS credentials: ${detail.message}`;
    case "http":
      if (detail.httpStatus === 404) return `Bucket "${bucket}" does not exist`;
      if (detail.httpStatus === 301) {
        return `Bucket "${bucket}" is in a different region; set --region (HTTP 301)`;
      }
      if (detail.httpStatus === 401 || detail.httpStatus === 403) {
        return `Access to bucket "${bucket}" was denied (HTTP ${detail.httpStatus}${
          detail.code ? ` ${detail.code}` : ""
        }); check credentials and permissions`;
      }
      return `HeadBucket failed with HTTP ${detail.httpStatus}${detail.code ? ` ${detail.code}` : ""}`;
    default:
      return `Preflight failed: ${detail.message}`;
  }
}

async function preflight(
  client: RunDependencies["client"] & object,
  send: Send,
  config: ResolvedConfig,
  redactor: Redactor,
  signal: AbortSignal,
): Promise<void> {
  const fail = (error: unknown, detail: CheckError): never => {
    if (signal.aborted || error instanceof RunAbortedError) {
      throw error instanceof RunAbortedError ? error : new RunAbortedError(detail.operation);
    }
    throw new EnvironmentError(environmentMessage(config.bucket, detail), detail);
  };

  const credentials = client.config?.credentials;
  if (typeof credentials === "function") {
    try {
      // Providers take no abort signal; the race still bounds a hung provider.
      const resolved = await withTimeout("ResolveCredentials", config.timeoutMs, signal, () =>
        credentials(),
      );
      redactor.addSecret(resolved.accessKeyId);
      redactor.addSecret(resolved.secretAccessKey);
      redactor.addSecret(resolved.sessionToken);
    } catch (error) {
      const classified = classifyError(error);
      fail(error, {
        ...classified,
        kind: classified.kind === "timeout" ? "timeout" : "credentials",
        ...(classified.kind === "timeout"
          ? { message: `Resolving credentials timed out after ${config.timeoutMs} ms` }
          : {}),
      });
    }
  }

  try {
    await send(new HeadBucketCommand({ Bucket: config.bucket }));
  } catch (error) {
    fail(error, classifyError(error));
  }

  // Never write into a namespace that already has content.
  let existing: number;
  try {
    const res = await send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.runPrefix, MaxKeys: 1 }),
    );
    existing = res.Contents?.length ?? res.KeyCount ?? 0;
  } catch (error) {
    const detail = classifyError(error);
    if (signal.aborted) fail(error, detail);
    throw new EnvironmentError(`ListObjectsV2 failed during preflight: ${detail.message}`, detail);
  }
  if (existing > 0) {
    throw new EnvironmentError(
      `The run prefix "${config.runPrefix}" already contains objects; refusing to continue`,
    );
  }
}

async function runOne(
  check: Check,
  config: ResolvedConfig,
  client: RunDependencies["client"] & object,
  tracker: ResourceTracker,
  signal: AbortSignal,
  onCall: (operation: string, durationMs: number, error?: unknown) => void,
  logger: ((message: string) => void) | undefined,
): Promise<CheckResult> {
  const base = { id: check.id, name: check.name, required: check.required };
  if (signal.aborted) {
    return {
      ...base,
      status: "skipped",
      durationMs: 0,
      error: { kind: "aborted", message: "Run was interrupted before this check started" },
    };
  }

  const send = timedSend(client, config.timeoutMs, signal, (op, ms, err) => {
    if (err && WRITE_OPERATIONS.has(op)) {
      const kind = classifyError(err).kind;
      if (kind === "timeout" || kind === "network" || kind === "aborted") {
        tracker.uncertainWrites = true;
      }
    }
    onCall(op, ms, err);
  });
  const ctx = createCheckContext({
    checkId: check.id,
    bucket: config.bucket,
    region: config.region,
    runPrefix: config.runPrefix,
    timeoutMs: config.timeoutMs,
    signal,
    client: client as S3Client,
    send,
    tracker,
    ...(logger ? { logger } : {}),
  });

  logger?.(`[${check.id}] start`);
  const started = performance.now();
  let status: CheckStatus = "passed";
  let error: CheckError | undefined;
  try {
    await check.run(ctx);
  } catch (e) {
    if (e instanceof UnsupportedFeature) {
      error = classifyError(e);
      if (check.required) {
        status = "failed";
        error = { ...error, message: `Required feature is not supported: ${error.message}` };
      } else {
        status = "unsupported";
      }
    } else if (e instanceof SkipCheck) {
      status = "skipped";
      error = { kind: "skipped", message: e.message };
    } else if (e instanceof RunAbortedError || signal.aborted) {
      status = "skipped";
      error = { ...classifyError(e), kind: "aborted" };
    } else {
      status = "failed";
      error = classifyError(e);
    }
  }
  const durationMs = Math.round(performance.now() - started);
  logger?.(`[${check.id}] ${status} (${durationMs} ms)`);
  return {
    ...base,
    status,
    durationMs,
    ...(error ? { error } : {}),
    ...(ctx.notes.length > 0 ? { details: [...ctx.notes] } : {}),
  };
}

/**
 * Run the selected checks against a bucket and return a typed report.
 *
 * Throws `ConfigError` for invalid options, `EnvironmentError` when the
 * endpoint/bucket cannot be used at all, and `RunAbortedError` if `signal`
 * fires before any check starts. Never writes to stdout/stderr.
 */
export function runChecks(options: RunOptions): Promise<RunReport> {
  return runChecksWith(options, {});
}

/** `runChecks` with test seams. Internal; not exported from the package. */
export async function runChecksWith(
  options: RunOptions,
  deps: RunDependencies,
): Promise<RunReport> {
  const env = options.env ?? process.env;
  const checks = deps.checks ?? ALL_CHECKS;
  const config = resolveConfig(
    options,
    checks.map((c) => c.id),
    env,
  );
  const redactor = createRedactor(env);
  const userLogger = options.logger;
  // Observer callbacks must never be able to break the run or skip cleanup.
  // Async callbacks are not awaited, and their rejections are swallowed.
  const observe = (fn: () => unknown, onError: (error: unknown) => void) => {
    try {
      const out = fn();
      if (out && typeof (out as PromiseLike<unknown>).then === "function") {
        Promise.resolve(out).catch(onError);
      }
    } catch (error) {
      onError(error);
    }
  };
  const logger = userLogger
    ? (m: string) =>
        observe(
          () => userLogger(redactor.redact(m)),
          () => undefined,
        )
    : undefined;
  const notifyComplete = (result: CheckResult) =>
    observe(
      () => options.onCheckComplete?.(redactor.redactDeep(result)),
      (error) => logger?.(`onCheckComplete failed: ${classifyError(error).message}`),
    );
  const runSignal = options.signal ?? new AbortController().signal;

  const startedAt = new Date();
  const t0 = performance.now();
  const client = deps.client ?? createS3Client(config, options.credentials);
  const tracker = new ResourceTracker(config.runPrefix);
  const logCall = (scope: string) => (op: string, ms: number, err?: unknown) => {
    if (!logger) return;
    let outcome = "ok";
    if (err) {
      const e = classifyError(err);
      outcome =
        e.kind === "http"
          ? `-> HTTP ${e.httpStatus}${e.code ? ` ${e.code}` : ""}`
          : `-> ${e.kind}: ${e.message}`;
    }
    logger(`[${scope}] ${op} ${outcome} (${Math.round(ms)} ms)`);
  };

  try {
    try {
      await preflight(
        client,
        timedSend(client, config.timeoutMs, runSignal, logCall("preflight")),
        config,
        redactor,
        runSignal,
      );
    } catch (error) {
      if (error instanceof EnvironmentError) {
        throw new EnvironmentError(
          redactor.redact(error.message),
          redactor.redactDeep(error.detail),
        );
      }
      throw error;
    }
    logger?.(`run prefix: ${config.runPrefix}`);

    const stats = new CleanupStats();
    const cleanupDeps = (deadline: AbortSignal) => ({
      send: timedSend(client, config.timeoutMs, deadline, logCall("cleanup")),
      bucket: config.bucket,
      tracker,
      concurrency: config.concurrency,
    });

    const selected = checks.filter((c) => config.checkIds.includes(c.id));
    let results: CheckResult[] | undefined;
    let runError: unknown;
    try {
      results = await mapWithConcurrency(selected, config.concurrency, async (check) => {
        const result = await runOne(
          check,
          config,
          client,
          tracker,
          runSignal,
          logCall(check.id),
          logger,
        );
        // Clean up as soon as the check ends so data does not linger. The
        // deadline is independent from the run signal so it survives SIGINT.
        await cleanupTracked(
          cleanupDeps(AbortSignal.timeout(config.cleanupTimeoutMs)),
          stats,
          check.id,
        );
        notifyComplete(result);
        return result;
      });
    } catch (error) {
      runError = error;
    }

    // Always runs, even if the check phase failed unexpectedly. The pool has
    // drained by now, so nothing can still be writing.
    // The final phase stays within --cleanup-timeout. Part of that budget is
    // reserved for verification so that a slow sweep cannot hide what is left.
    const cleanupStarted = performance.now();
    const verifyBudget = Math.min(
      Math.max(config.timeoutMs * 2, 1_000),
      Math.floor(config.cleanupTimeoutMs / 3),
    );
    const finalDeps = cleanupDeps(AbortSignal.timeout(config.cleanupTimeoutMs - verifyBudget));
    await cleanupTracked(finalDeps, stats);
    await sweepRunPrefix(finalDeps, stats);
    const remaining = await findRemaining(cleanupDeps(AbortSignal.timeout(verifyBudget)), stats);
    const cleanup: CleanupReport = stats.toReport(remaining, performance.now() - cleanupStarted);
    logger?.(
      `cleanup ${cleanup.status}: ${cleanup.deletedObjects} objects deleted, ${cleanup.abortedUploads} uploads aborted`,
    );
    if (runError !== undefined || !results) throw runError;

    const summary = summarize(results);
    const aborted = runSignal.aborted;
    const report: RunReport = {
      schemaVersion: "1.0",
      tool: TOOL_NAME,
      toolVersion: TOOL_VERSION,
      ok: isRunSuccessful(summary, cleanup, aborted),
      aborted,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
      endpoint: config.endpoint ?? null,
      bucket: config.bucket,
      region: config.region,
      addressingStyle: config.addressingStyle,
      runPrefix: config.runPrefix,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        awsSdkVersion: awsSdkVersion(),
      },
      summary,
      checks: results,
      cleanup,
    };
    return redactor.redactDeep(report);
  } finally {
    if (!deps.client) client.destroy?.();
  }
}
