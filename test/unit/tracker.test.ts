import { describe, expect, it } from "vitest";
import { CleanupStats, cleanupTracked } from "../../src/core/cleanup.js";
import type { Send } from "../../src/core/s3.js";
import { ResourceTracker } from "../../src/core/tracker.js";
import { FakeS3, s3Error } from "./fake-s3.js";

const PREFIX = "s3-compat-check/20260102T030405Z-0123abcd/";

describe("ResourceTracker", () => {
  it("refuses keys outside the run prefix", () => {
    const t = new ResourceTracker(PREFIX);
    expect(() => t.addObject("other/key", "put")).toThrow(/outside the run prefix/);
    expect(() => t.addUpload("other/key", "id", "put")).toThrow(/outside the run prefix/);
  });

  it("tracks objects, versions and uploads per owner", () => {
    const t = new ResourceTracker(PREFIX);
    t.addObject(`${PREFIX}a/1`, "a");
    t.addObject(`${PREFIX}b/1`, "b");
    t.addVersion(`${PREFIX}b/1`, undefined);
    expect(t.versioningObserved).toBe(false);
    t.addVersion(`${PREFIX}b/1`, "v1");
    expect(t.versioningObserved).toBe(true);
    t.addUpload(`${PREFIX}a/2`, "u1", "a");

    expect(t.pendingObjects("a").map((o) => o.key)).toEqual([`${PREFIX}a/1`]);
    expect(t.pendingObjects("b")[0]?.versions).toEqual(["v1"]);
    expect(t.pendingUploads("a")).toHaveLength(1);
    expect(t.pendingUploads("b")).toHaveLength(0);

    t.markDeleted(`${PREFIX}a/1`);
    t.markDeleted(`${PREFIX}b/1`, "v1");
    t.removeUpload("u1");
    // Removing every tracked version removes the key.
    expect(t.pendingObjects()).toEqual([]);
    expect(t.pendingUploads()).toHaveLength(0);
  });
});

describe("cleanupTracked", () => {
  it("deletes versions individually and treats 404 as success", async () => {
    const fake = new FakeS3();
    const deleted: string[] = [];
    fake.overrides.DeleteObject = (input) => {
      deleted.push(`${input.Key as string}@${(input.VersionId as string) ?? "-"}`);
      if (input.Key === `${PREFIX}gone`) throw s3Error(404, "NoSuchKey");
      return { $metadata: { httpStatusCode: 204 } };
    };
    const t = new ResourceTracker(PREFIX);
    t.addObject(`${PREFIX}plain`, "x");
    t.addObject(`${PREFIX}versioned`, "x");
    t.addVersion(`${PREFIX}versioned`, "v1");
    t.addVersion(`${PREFIX}versioned`, "v2");
    t.addObject(`${PREFIX}gone`, "x");

    const stats = new CleanupStats();
    await cleanupTracked(
      { send: fake.send as unknown as Send, bucket: "b", tracker: t, concurrency: 2 },
      stats,
    );
    expect(deleted.sort()).toEqual([
      `${PREFIX}gone@-`,
      `${PREFIX}plain@-`,
      `${PREFIX}versioned@v1`,
      `${PREFIX}versioned@v2`,
    ]);
    expect(stats.errors).toEqual([]);
    expect(t.pendingObjects()).toEqual([]);
  });

  it("aborts pending uploads", async () => {
    const fake = new FakeS3();
    fake.uploads.set("u1", { key: `${PREFIX}mp`, parts: new Map() });
    const t = new ResourceTracker(PREFIX);
    t.addUpload(`${PREFIX}mp`, "u1", "multipart");
    const stats = new CleanupStats();
    await cleanupTracked(
      { send: fake.send as unknown as Send, bucket: "b", tracker: t, concurrency: 2 },
      stats,
    );
    expect(stats.abortedUploads).toBe(1);
    expect(fake.uploads.size).toBe(0);
  });
});
