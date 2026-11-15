import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import { classifyError, httpErrorInfo } from "./errors.js";
import { mapWithConcurrency } from "./pool.js";
import type { CleanupError, CleanupReport } from "./result.js";
import type { Send } from "./s3.js";
import type { ResourceTracker } from "./tracker.js";

export interface CleanupDeps {
  /** A send function bound to the cleanup deadline, not to the run signal. */
  send: Send;
  bucket: string;
  tracker: ResourceTracker;
  concurrency: number;
}

const MAX_LIST_PAGES = 50;

export class CleanupStats {
  deletedObjects = 0;
  abortedUploads = 0;
  errors: CleanupError[] = [];
  warnings: string[] = [];

  recordError(operation: string, error: unknown, key?: string): void {
    const e = classifyError(error);
    this.errors.push({
      operation,
      ...(key !== undefined ? { key } : {}),
      message: e.message,
      ...(e.code !== undefined ? { code: e.code } : {}),
      ...(e.httpStatus !== undefined ? { httpStatus: e.httpStatus } : {}),
    });
  }

  toReport(remaining: string[], durationMs: number): CleanupReport {
    return {
      status: this.errors.length === 0 && remaining.length === 0 ? "completed" : "failed",
      deletedObjects: this.deletedObjects,
      abortedUploads: this.abortedUploads,
      remaining,
      errors: this.errors,
      warnings: this.warnings,
      durationMs: Math.round(durationMs),
    };
  }
}

function isNotFound(error: unknown, codes: readonly string[]): boolean {
  const info = httpErrorInfo(error);
  return (
    !!info && (info.httpStatus === 404 || (info.code !== undefined && codes.includes(info.code)))
  );
}

function isNotImplemented(error: unknown): boolean {
  const info = httpErrorInfo(error);
  return !!info && (info.httpStatus === 501 || info.code === "NotImplemented");
}

async function deleteKey(
  deps: CleanupDeps,
  stats: CleanupStats,
  key: string,
  versionId?: string,
): Promise<void> {
  // Defense in depth: never delete anything outside the run namespace.
  if (!deps.tracker.owns(key)) {
    stats.warnings.push(`Skipped deleting a key outside the run prefix`);
    return;
  }
  try {
    await deps.send(
      new DeleteObjectCommand({
        Bucket: deps.bucket,
        Key: key,
        ...(versionId ? { VersionId: versionId } : {}),
      }),
    );
    stats.deletedObjects++;
    deps.tracker.markDeleted(key, versionId);
  } catch (error) {
    if (isNotFound(error, ["NoSuchKey", "NoSuchVersion"])) {
      deps.tracker.markDeleted(key, versionId);
      return;
    }
    stats.recordError("DeleteObject", error, key);
  }
}

async function abortUpload(
  deps: CleanupDeps,
  stats: CleanupStats,
  key: string,
  uploadId: string,
): Promise<void> {
  if (!deps.tracker.owns(key)) {
    stats.warnings.push(`Skipped aborting an upload outside the run prefix`);
    return;
  }
  try {
    await deps.send(
      new AbortMultipartUploadCommand({ Bucket: deps.bucket, Key: key, UploadId: uploadId }),
    );
    stats.abortedUploads++;
    deps.tracker.removeUpload(uploadId);
  } catch (error) {
    if (isNotFound(error, ["NoSuchUpload"])) {
      deps.tracker.removeUpload(uploadId);
      return;
    }
    stats.recordError("AbortMultipartUpload", error, key);
  }
}

/** Remove everything tracked (optionally only for one check). */
export async function cleanupTracked(
  deps: CleanupDeps,
  stats: CleanupStats,
  owner?: string,
): Promise<void> {
  await mapWithConcurrency(deps.tracker.pendingUploads(owner), deps.concurrency, (u) =>
    abortUpload(deps, stats, u.key, u.uploadId),
  );
  const jobs: Array<{ key: string; versionId?: string }> = [];
  for (const obj of deps.tracker.pendingObjects(owner)) {
    if (obj.versions.length > 0) {
      for (const versionId of obj.versions) jobs.push({ key: obj.key, versionId });
    } else {
      jobs.push({ key: obj.key });
    }
  }
  await mapWithConcurrency(jobs, deps.concurrency, (j) =>
    deleteKey(deps, stats, j.key, j.versionId),
  );
}

async function listKeys(deps: CleanupDeps): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await deps.send(
      new ListObjectsV2Command({
        Bucket: deps.bucket,
        Prefix: deps.tracker.runPrefix,
        ...(token ? { ContinuationToken: token } : {}),
      }),
    );
    for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
    if (!res.IsTruncated || !res.NextContinuationToken) break;
    token = res.NextContinuationToken;
  }
  return keys.filter((k) => deps.tracker.owns(k));
}

async function listVersions(deps: CleanupDeps): Promise<Array<{ key: string; versionId: string }>> {
  const out: Array<{ key: string; versionId: string }> = [];
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await deps.send(
      new ListObjectVersionsCommand({
        Bucket: deps.bucket,
        Prefix: deps.tracker.runPrefix,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionMarker ? { VersionIdMarker: versionMarker } : {}),
      }),
    );
    for (const v of [...(res.Versions ?? []), ...(res.DeleteMarkers ?? [])]) {
      if (v.Key && v.VersionId && deps.tracker.owns(v.Key)) {
        out.push({ key: v.Key, versionId: v.VersionId });
      }
    }
    if (!res.IsTruncated) break;
    keyMarker = res.NextKeyMarker;
    versionMarker = res.NextVersionIdMarker;
  }
  return out;
}

async function listUploads(deps: CleanupDeps): Promise<Array<{ key: string; uploadId: string }>> {
  const res = await deps.send(
    new ListMultipartUploadsCommand({ Bucket: deps.bucket, Prefix: deps.tracker.runPrefix }),
  );
  return (res.Uploads ?? [])
    .filter((u) => u.Key && u.UploadId && deps.tracker.owns(u.Key))
    .map((u) => ({ key: u.Key as string, uploadId: u.UploadId as string }));
}

/**
 * Remove anything left under the run prefix that tracking may have missed
 * (e.g. a request that timed out after the server stored the object). The run
 * prefix contains a random id, so everything below it was created by this run.
 */
export async function sweepRunPrefix(deps: CleanupDeps, stats: CleanupStats): Promise<void> {
  try {
    const keys = await listKeys(deps);
    await mapWithConcurrency(keys, deps.concurrency, (key) => deleteKey(deps, stats, key));
  } catch (error) {
    stats.recordError("ListObjectsV2", error);
  }

  if (deps.tracker.versioningObserved) {
    try {
      const versions = await listVersions(deps);
      await mapWithConcurrency(versions, deps.concurrency, (v) =>
        deleteKey(deps, stats, v.key, v.versionId),
      );
    } catch (error) {
      stats.recordError("ListObjectVersions", error);
    }
  }

  try {
    const uploads = await listUploads(deps);
    await mapWithConcurrency(uploads, deps.concurrency, (u) =>
      abortUpload(deps, stats, u.key, u.uploadId),
    );
  } catch (error) {
    if (isNotImplemented(error)) {
      stats.warnings.push("ListMultipartUploads is not implemented; skipped upload sweep");
    } else {
      stats.recordError("ListMultipartUploads", error);
    }
  }
}

/** Keys and uploads that are still present after cleanup. */
export async function findRemaining(deps: CleanupDeps, stats: CleanupStats): Promise<string[]> {
  const remaining = new Set<string>();
  try {
    for (const key of await listKeys(deps)) remaining.add(key);
  } catch (error) {
    stats.recordError("ListObjectsV2", error);
    for (const obj of deps.tracker.pendingObjects()) remaining.add(obj.key);
  }
  if (deps.tracker.versioningObserved) {
    try {
      for (const v of await listVersions(deps)) remaining.add(v.key);
    } catch (error) {
      stats.recordError("ListObjectVersions", error);
    }
  }
  for (const u of deps.tracker.pendingUploads()) remaining.add(`${u.key} (multipart upload)`);
  return [...remaining].sort();
}
