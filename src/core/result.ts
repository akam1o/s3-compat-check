import type { CheckError } from "./errors.js";

export type CheckStatus = "passed" | "failed" | "skipped" | "unsupported";

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  /** Required checks can never be "unsupported"; that is reported as "failed". */
  required: boolean;
  durationMs: number;
  error?: CheckError;
  /** Observations recorded by the check (e.g. ETag format, error codes seen). */
  details?: string[];
}

export interface Summary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  unsupported: number;
}

export interface CleanupError {
  operation: string;
  key?: string;
  message: string;
  code?: string;
  httpStatus?: number;
}

export interface CleanupReport {
  /** "completed": nothing left behind. "failed": something may remain. */
  status: "completed" | "failed";
  deletedObjects: number;
  abortedUploads: number;
  /** Keys (all under the run prefix) that could not be removed. */
  remaining: string[];
  errors: CleanupError[];
  warnings: string[];
  durationMs: number;
}

export interface RunReport {
  schemaVersion: "1.0";
  tool: "s3-compat-check";
  toolVersion: string;
  /** True when no check failed, cleanup succeeded and the run was not aborted. */
  ok: boolean;
  aborted: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Sanitized endpoint URL, or null when the AWS default endpoint is used. */
  endpoint: string | null;
  bucket: string;
  region: string;
  addressingStyle: "path" | "virtual-hosted";
  runPrefix: string;
  environment: {
    node: string;
    platform: string;
    arch: string;
    awsSdkVersion: string;
  };
  summary: Summary;
  checks: CheckResult[];
  cleanup: CleanupReport;
}

export function summarize(results: readonly CheckResult[]): Summary {
  const summary: Summary = {
    total: results.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    unsupported: 0,
  };
  for (const r of results) summary[r.status]++;
  return summary;
}

export function isRunSuccessful(
  summary: Summary,
  cleanup: CleanupReport,
  aborted: boolean,
): boolean {
  return summary.failed === 0 && cleanup.status !== "failed" && !aborted;
}
