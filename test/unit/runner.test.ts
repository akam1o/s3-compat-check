import { PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { ALL_CHECKS } from "../../src/checks/index.js";
import type { Check } from "../../src/checks/types.js";
import {
  AssertionFailure,
  EnvironmentError,
  SkipCheck,
  UnsupportedFeature,
} from "../../src/core/errors.js";
import { runChecks, type RunDependencies } from "../../src/core/runner.js";
import { FakeS3, s3Error } from "./fake-s3.js";

const ENV = {
  AWS_ACCESS_KEY_ID: "ACCESS_KEY_EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "SECRET_KEY_EXAMPLE_VALUE",
};

function deps(fake: FakeS3, checks?: readonly Check[]): RunDependencies {
  return { client: fake as unknown as RunDependencies["client"], ...(checks ? { checks } : {}) };
}

const offline = ALL_CHECKS.filter((c) => c.id !== "presigned");

function check(id: string, run: Check["run"], required = true): Check {
  return { id, name: id.toUpperCase(), description: id, required, run };
}

describe("runChecks with the in-memory fake", () => {
  it("passes every offline check against a well-behaved server and cleans up", async () => {
    const fake = new FakeS3();
    const report = await runChecks(
      { bucket: "test-bucket", endpoint: "http://localhost:9000", env: ENV },
      deps(fake, offline),
    );
    expect(report.checks.map((c) => [c.id, c.status, c.error?.message])).toEqual(
      offline.map((c) => [c.id, "passed", undefined]),
    );
    expect(report.ok).toBe(true);
    expect(report.summary).toEqual({
      total: offline.length,
      passed: offline.length,
      failed: 0,
      skipped: 0,
      unsupported: 0,
    });
    expect(report.cleanup.status).toBe("completed");
    expect(fake.objects.size).toBe(0);
    expect(fake.uploads.size).toBe(0);
    expect(report.schemaVersion).toBe("1.0");
    expect(report.endpoint).toBe("http://localhost:9000");
    expect(report.addressingStyle).toBe("path");
  });

  it("reports a wrong Content-Range with expected and actual values", async () => {
    const fake = new FakeS3();
    fake.overrides.GetObject = (input, f) => {
      const res = f.handle("GetObject", input) as Record<string, unknown>;
      if (input.Range === "bytes=-100") res.ContentRange = "bytes 0-99/1024";
      return res;
    };
    const report = await runChecks(
      {
        bucket: "test-bucket",
        endpoint: "http://localhost:9000",
        checks: ["range", "get"],
        env: ENV,
      },
      deps(fake, offline),
    );
    const range = report.checks.find((c) => c.id === "range");
    expect(range?.status).toBe("failed");
    expect(range?.error).toMatchObject({
      kind: "assertion",
      operation: "GetObject Range: bytes=-100",
      expected: '"bytes 924-1023/1024"',
      actual: '"bytes 0-99/1024"',
    });
    // An unrelated check is unaffected.
    expect(report.checks.find((c) => c.id === "get")?.status).toBe("passed");
    expect(report.ok).toBe(false);
    expect(fake.objects.size).toBe(0);
  });

  it("reports unsupported checksums for servers that reject the header", async () => {
    const fake = new FakeS3();
    fake.overrides.PutObject = (input, f) => {
      if (input.ChecksumSHA256) throw s3Error(501, "NotImplemented");
      return f.handle("PutObject", input);
    };
    const report = await runChecks(
      { bucket: "test-bucket", endpoint: "http://localhost:9000", checks: ["checksum"], env: ENV },
      deps(fake, offline),
    );
    expect(report.checks[0]).toMatchObject({
      id: "checksum",
      status: "unsupported",
      error: { httpStatus: 501, code: "NotImplemented" },
    });
    expect(report.ok).toBe(true);
  });

  it("reports unsupported checksums for servers that silently ignore them", async () => {
    const fake = new FakeS3();
    fake.overrides.PutObject = (input, f) => {
      const { ChecksumSHA256: _ignored, ...rest } = input;
      return f.handle("PutObject", rest);
    };
    const report = await runChecks(
      { bucket: "test-bucket", endpoint: "http://localhost:9000", checks: ["checksum"], env: ENV },
      deps(fake, offline),
    );
    expect(report.checks[0]?.status).toBe("unsupported");
    expect(report.checks[0]?.error?.message).toMatch(/ignored/);
    expect(fake.objects.size).toBe(0);
  });

  it("fails the nonexistent check when GET returns 403 instead of 404", async () => {
    const fake = new FakeS3();
    fake.overrides.GetObject = () => {
      throw s3Error(403, "AccessDenied");
    };
    const report = await runChecks(
      {
        bucket: "test-bucket",
        endpoint: "http://localhost:9000",
        checks: ["nonexistent"],
        env: ENV,
      },
      deps(fake, offline),
    );
    expect(report.checks[0]).toMatchObject({
      status: "failed",
      error: { kind: "assertion", expected: '"404 NoSuchKey"', actual: '"403 AccessDenied"' },
    });
  });

  it("aborts a failed multipart upload", async () => {
    const fake = new FakeS3();
    let parts = 0;
    fake.overrides.UploadPart = (input, f) => {
      if (++parts === 2) throw s3Error(500, "InternalError");
      return f.handle("UploadPart", input);
    };
    const report = await runChecks(
      { bucket: "test-bucket", endpoint: "http://localhost:9000", checks: ["multipart"], env: ENV },
      deps(fake, offline),
    );
    expect(report.checks[0]).toMatchObject({
      status: "failed",
      error: { kind: "http", httpStatus: 500, code: "InternalError", operation: "UploadPart" },
    });
    expect(fake.calls).toContain("AbortMultipartUpload");
    expect(fake.uploads.size).toBe(0);
    expect(report.cleanup.status).toBe("completed");
  });
});

describe("runChecks orchestration", () => {
  it("keeps result order fixed under concurrency", async () => {
    const fake = new FakeS3();
    const checks = [50, 1, 25, 5].map((ms, i) =>
      check(`c${i}`, () => new Promise((r) => setTimeout(r, ms))),
    );
    const completed: string[] = [];
    const report = await runChecks(
      {
        bucket: "test-bucket",
        concurrency: 4,
        env: ENV,
        onCheckComplete: (r) => completed.push(r.id),
      },
      deps(fake, checks),
    );
    expect(report.checks.map((c) => c.id)).toEqual(["c0", "c1", "c2", "c3"]);
    expect(completed).toEqual(["c1", "c3", "c2", "c0"]);
  });

  it("maps outcomes to statuses", async () => {
    const fake = new FakeS3();
    const report = await runChecks(
      { bucket: "test-bucket", env: ENV },
      deps(fake, [
        check("ok", async () => undefined),
        check("bad", async () => {
          throw new AssertionFailure("nope", { expected: 1, actual: 2 });
        }),
        check(
          "opt",
          async () => {
            throw new UnsupportedFeature("not here");
          },
          false,
        ),
        check("req", async () => {
          throw new UnsupportedFeature("not here");
        }),
        check("skip", async () => {
          throw new SkipCheck("cannot run");
        }),
      ]),
    );
    expect(report.checks.map((c) => c.status)).toEqual([
      "passed",
      "failed",
      "unsupported",
      "failed",
      "skipped",
    ]);
    expect(report.checks[3]?.error?.message).toMatch(/Required feature is not supported/);
    expect(report.summary).toMatchObject({ passed: 1, failed: 2, unsupported: 1, skipped: 1 });
    expect(report.ok).toBe(false);
  });

  it("cleans up objects a failing check created", async () => {
    const fake = new FakeS3();
    const report = await runChecks(
      { bucket: "test-bucket", env: ENV },
      deps(fake, [
        check("writer", async (ctx) => {
          const key = ctx.key("x.bin");
          await ctx.send(
            new PutObjectCommand({ Bucket: ctx.bucket, Key: key, Body: Buffer.from("x") }),
          );
          throw new Error("after write");
        }),
      ]),
    );
    expect(report.checks[0]?.status).toBe("failed");
    expect(fake.objects.size).toBe(0);
    expect(report.cleanup).toMatchObject({ status: "completed", deletedObjects: 1 });
  });

  it("removes untracked leftovers under the run prefix but never touches other keys", async () => {
    const fake = new FakeS3();
    fake.objects.set("unrelated/keep.bin", { body: Buffer.from("k"), etag: '"x"' });
    fake.objects.set("s3-compat-check/20200101T000000Z-00000000/old.bin", {
      body: Buffer.from("k"),
      etag: '"x"',
    });
    const report = await runChecks(
      { bucket: "test-bucket", env: ENV },
      deps(fake, [
        check("sneaky", async (ctx) => {
          // Simulates a write the tracker did not see (e.g. timed out after storing).
          await ctx.send(
            new PutObjectCommand({
              Bucket: ctx.bucket,
              Key: `${ctx.prefix}untracked`,
              Body: Buffer.from("x"),
            }),
          );
        }),
      ]),
    );
    expect(report.cleanup.status).toBe("completed");
    expect([...fake.objects.keys()].sort()).toEqual([
      "s3-compat-check/20200101T000000Z-00000000/old.bin",
      "unrelated/keep.bin",
    ]);
  });

  it("reports cleanup failures and remaining keys", async () => {
    const fake = new FakeS3();
    fake.overrides.DeleteObject = () => {
      throw s3Error(403, "AccessDenied", "Access Denied");
    };
    const report = await runChecks(
      { bucket: "test-bucket", env: ENV },
      deps(fake, [
        check("writer", async (ctx) => {
          const key = ctx.key("x.bin");
          await ctx.send(
            new PutObjectCommand({ Bucket: ctx.bucket, Key: key, Body: Buffer.from("x") }),
          );
        }),
      ]),
    );
    expect(report.checks[0]?.status).toBe("passed");
    expect(report.cleanup.status).toBe("failed");
    expect(report.cleanup.remaining).toEqual([`${report.runPrefix}writer/x.bin`]);
    expect(report.cleanup.errors[0]).toMatchObject({
      operation: "DeleteObject",
      httpStatus: 403,
      code: "AccessDenied",
    });
    expect(report.ok).toBe(false);
  });

  it("skips remaining checks after an abort and still cleans up", async () => {
    const fake = new FakeS3();
    const controller = new AbortController();
    const report = await runChecks(
      { bucket: "test-bucket", concurrency: 1, env: ENV, signal: controller.signal },
      deps(fake, [
        check("first", async (ctx) => {
          const key = ctx.key("x.bin");
          await ctx.send(
            new PutObjectCommand({ Bucket: ctx.bucket, Key: key, Body: Buffer.from("x") }),
          );
          controller.abort();
          await ctx.send(
            new PutObjectCommand({ Bucket: ctx.bucket, Key: key, Body: Buffer.from("y") }),
          );
        }),
        check("second", async () => undefined),
      ]),
    );
    expect(report.aborted).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.checks.map((c) => c.status)).toEqual(["skipped", "skipped"]);
    expect(report.checks[0]?.error?.kind).toBe("aborted");
    expect(fake.objects.size).toBe(0);
  });

  it("times out slow operations", async () => {
    const fake = new FakeS3();
    fake.overrides.PutObject = () => new Promise(() => undefined);
    const started = Date.now();
    const report = await runChecks(
      {
        bucket: "test-bucket",
        endpoint: "http://localhost:9000",
        checks: ["put"],
        timeoutMs: 100,
        env: ENV,
      },
      deps(fake, offline),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report.checks[0]?.error).toMatchObject({ kind: "timeout", operation: "PutObject" });
  });

  it("throws EnvironmentError when the bucket is not accessible", async () => {
    const fake = new FakeS3();
    fake.overrides.HeadBucket = () => {
      throw s3Error(404, "NotFound", "UnknownError");
    };
    await expect(
      runChecks({ bucket: "missing-bucket", env: ENV }, deps(fake, offline)),
    ).rejects.toThrow(EnvironmentError);
    expect(fake.calls).toEqual(["HeadBucket"]);
  });

  it("throws EnvironmentError when credentials cannot be resolved", async () => {
    const fake = new FakeS3();
    (fake.config as { credentials: () => Promise<never> }).credentials = async () => {
      throw Object.assign(new Error("Could not load credentials"), {
        name: "CredentialsProviderError",
      });
    };
    await expect(runChecks({ bucket: "test-bucket", env: ENV }, deps(fake))).rejects.toMatchObject({
      name: "EnvironmentError",
      detail: { kind: "credentials" },
    });
  });

  it("redacts secrets from check results", async () => {
    const fake = new FakeS3();
    const report = await runChecks(
      { bucket: "test-bucket", env: ENV },
      deps(fake, [
        check("leaky", async (ctx) => {
          ctx.note("note SECRET_KEY_EXAMPLE_VALUE");
          throw new Error(
            "bad https://storage.example.com/k?X-Amz-Signature=abcdef0123456789 SECRET_KEY_EXAMPLE_VALUE",
          );
        }),
      ]),
    );
    const json = JSON.stringify(report);
    expect(json).not.toContain("SECRET_KEY_EXAMPLE_VALUE");
    expect(json).not.toContain("abcdef0123456789");
    expect(json).toContain("[REDACTED]");
  });

  it("does not log anything unless a logger is given", async () => {
    const fake = new FakeS3();
    const lines: string[] = [];
    await runChecks(
      { bucket: "test-bucket", env: ENV },
      deps(fake, [check("a", async () => undefined)]),
    );
    await runChecks(
      { bucket: "test-bucket", env: ENV, logger: (m) => lines.push(m) },
      deps(fake, [check("a", async () => undefined)]),
    );
    expect(lines.some((l) => l.includes("[a] passed"))).toBe(true);
  });
});
