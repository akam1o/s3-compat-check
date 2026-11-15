import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
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

/** The server cannot (or will not let us) list versions: no versioning support or permission. */
function isVersionListingUnavailable(error: unknown): boolean {
  const info = httpErrorInfo(error);
  if (!info) return false;
  return (
    isNotImplemented(error) ||
    [400, 403, 405].includes(info.httpStatus) ||
    ["AccessDenied", "MethodNotAllowed", "InvalidArgument", "InvalidRequest"].includes(
      info.code ?? "",
    )
  );
}

class IncompleteListingError extends Error {
  override readonly name = "IncompleteListingError";
}

async function deleteKey(
  deps: CleanupDeps,
  stats: CleanupStats,
  key: string,
  versionId?: string,
): Promise<boolean> {
  // Defense in depth: never delete anything outside the run namespace.
  if (!deps.tracker.owns(key)) {
    stats.warnings.push(`Skipped deleting a key outside the run prefix`);
    return false;
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
    return true;
  } catch (error) {
    if (isNotFound(error, ["NoSuchKey", "NoSuchVersion"])) {
      deps.tracker.markDeleted(key, versionId);
      return true;
    }
    const info = httpErrorInfo(error);
    if (versionId === "null" && info && (info.httpStatus === 400 || info.httpStatus === 501)) {
      // Some implementations reject an explicit "null" version id; fall back to
      // a plain delete, and only stop tracking the version if that succeeds.
      const ok = await deleteKey(deps, stats, key);
      if (ok) deps.tracker.markDeleted(key, versionId);
      return ok;
    }
    stats.recordError("DeleteObject", error, key);
    return false;
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
    if (!res.IsTruncated) return keys.filter((k) => deps.tracker.owns(k));
    if (!res.NextContinuationToken) {
      throw new IncompleteListingError(
        "ListObjectsV2 returned IsTruncated=true without a continuation token",
      );
    }
    token = res.NextContinuationToken;
  }
  throw new IncompleteListingError(`ListObjectsV2 did not finish within ${MAX_LIST_PAGES} pages`);
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
    if (!res.IsTruncated) return out;
    if (!res.NextKeyMarker && !res.NextVersionIdMarker) {
      throw new IncompleteListingError(
        "ListObjectVersions returned IsTruncated=true without a next marker",
      );
    }
    keyMarker = res.NextKeyMarker;
    versionMarker = res.NextVersionIdMarker;
  }
  throw new IncompleteListingError(
    `ListObjectVersions did not finish within ${MAX_LIST_PAGES} pages`,
  );
}

/** True only if the bucket has provably never had versioning enabled. */
async function bucketNeverVersioned(deps: CleanupDeps): Promise<boolean> {
  try {
    const res = await deps.send(new GetBucketVersioningCommand({ Bucket: deps.bucket }));
    return res.Status === undefined;
  } catch {
    return false;
  }
}

/**
 * List versions under the run prefix. Versioning may be active even if no
 * write reported a version id (e.g. a timed-out PUT), so this is always
 * attempted. If listing is unavailable, that is only tolerated when no real
 * version id was seen and either every write had a definite outcome or the
 * bucket provably never had versioning enabled; otherwise the cleanup cannot
 * be verified and is reported as failed.
 */
async function tryListVersions(
  deps: CleanupDeps,
  stats: CleanupStats,
): Promise<Array<{ key: string; versionId: string }>> {
  try {
    return await listVersions(deps);
  } catch (error) {
    if (
      !deps.tracker.versioningObserved &&
      isVersionListingUnavailable(error) &&
      (!deps.tracker.uncertainWrites || (await bucketNeverVersioned(deps)))
    ) {
      return [];
    }
    stats.recordError("ListObjectVersions", error);
    return [];
  }
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

  const versions = await tryListVersions(deps, stats);
  await mapWithConcurrency(versions, deps.concurrency, (v) =>
    deleteKey(deps, stats, v.key, v.versionId),
  );

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
  for (const v of await tryListVersions(deps, stats)) remaining.add(v.key);
  for (const u of deps.tracker.pendingUploads()) remaining.add(`${u.key} (multipart upload)`);
  return [...remaining].sort();
}
