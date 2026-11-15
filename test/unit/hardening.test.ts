import { PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { main, type CliIo } from "../../src/cli/index.js";
import { ALL_CHECKS } from "../../src/checks/index.js";
import type { Check } from "../../src/checks/types.js";
import {
  CleanupStats,
  cleanupTracked,
  findRemaining,
  sweepRunPrefix,
} from "../../src/core/cleanup.js";
import { ConfigError, EnvironmentError, RunAbortedError } from "../../src/core/errors.js";
import { mapWithConcurrency } from "../../src/core/pool.js";
import { Redactor } from "../../src/core/redact.js";
import { runChecksWith, type RunDependencies } from "../../src/core/runner.js";
import type { Send } from "../../src/core/s3.js";
import { ResourceTracker } from "../../src/core/tracker.js";
import { resolveConfig } from "../../src/core/config.js";
import { FakeS3, s3Error } from "./fake-s3.js";

const ENV = {
  AWS_ACCESS_KEY_ID: "ACCESS_KEY_EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "SECRET_KEY_EXAMPLE_VALUE",
};
const PREFIX = "s3-compat-check/20260102T030405Z-0123abcd/";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const offline = ALL_CHECKS.filter((c) => c.id !== "presigned");

function deps(fake: FakeS3, checks: readonly Check[] = offline): RunDependencies {
  return { client: fake as unknown as RunDependencies["client"], checks };
}

function run(fake: FakeS3, options: Record<string, unknown>, checks?: readonly Check[]) {
  return runChecksWith(
    { bucket: "test-bucket", endpoint: "http://localhost:9000", env: ENV, ...options },
    deps(fake, checks),
  );
}

describe("pool draining", () => {
  it("waits for in-flight work and starts nothing new after a failure", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4], 2, async (i) => {
        started.push(i);
        if (i === 0) throw new Error("boom");
        await sleep(30);
        finished.push(i);
      }),
    ).rejects.toThrow("boom");
    // Item 1 was already in flight and completed before the rejection; nothing else started.
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([1]);
  });

  it("leaves nothing behind when one list PUT fails while others are slow", async () => {
    const fake = new FakeS3();
    let n = 0;
    fake.overrides.PutObject = async (input, f) => {
      if (n++ === 0) throw s3Error(500, "InternalError");
      await sleep(50);
      return f.handle("PutObject", input);
    };
    const report = await run(fake, { checks: ["list"] });
    expect(report.checks[0]?.status).toBe("failed");
    await sleep(100);
    expect(fake.objects.size).toBe(0);
    expect(report.cleanup.status).toBe("completed");
  });
});

describe("versioning-suspended buckets", () => {
  it("deletes the null version and the null delete marker explicitly", async () => {
    const fake = new FakeS3();
    const deletes: Array<string | undefined> = [];
    fake.overrides.PutObject = (input, f) => ({
      ...(f.handle("PutObject", input) as object),
      VersionId: "null",
    });
    fake.overrides.DeleteObject = (input, f) => {
      deletes.push(input.VersionId as string | undefined);
      f.handle("DeleteObject", input);
      return {
        $metadata: { httpStatusCode: 204 },
        VersionId: "null",
        DeleteMarker: !input.VersionId,
      };
    };
    const report = await run(fake, { checks: ["delete"] });
    expect(report.checks[0]?.status).toBe("passed");
    expect(deletes).toContain("null");
    expect(report.cleanup.status).toBe("completed");
  });

  it("falls back to a plain delete if an explicit null version id is rejected", async () => {
    const fake = new FakeS3();
    fake.objects.set(`${PREFIX}x`, { body: Buffer.from("x"), etag: '"e"' });
    fake.overrides.DeleteObject = (input, f) => {
      if (input.VersionId === "null") throw s3Error(400, "InvalidArgument");
      return f.handle("DeleteObject", input);
    };
    const tracker = new ResourceTracker(PREFIX);
    tracker.addObject(`${PREFIX}x`, "t");
    tracker.addVersion(`${PREFIX}x`, "null");
    const stats = new CleanupStats();
    await cleanupTracked(
      { send: fake.send as unknown as Send, bucket: "b", tracker, concurrency: 1 },
      stats,
    );
    expect(stats.errors).toEqual([]);
    expect(fake.objects.size).toBe(0);
  });

  it("always probes for versions, even when no write reported a version id", async () => {
    const fake = new FakeS3();
    let probed = false;
    fake.overrides.ListObjectVersions = (input, f) => {
      probed = true;
      return f.handle("ListObjectVersions", input);
    };
    await run(fake, { checks: ["put"] });
    expect(probed).toBe(true);
  });

  it("tolerates servers without version listing on unversioned buckets", async () => {
    const fake = new FakeS3();
    fake.overrides.ListObjectVersions = () => {
      throw s3Error(501, "NotImplemented");
    };
    const report = await run(fake, { checks: ["put"] });
    expect(report.cleanup).toMatchObject({ status: "completed", errors: [] });
  });
});

describe("incomplete listings", () => {
  it("fails cleanup instead of reporting a clean sweep", async () => {
    const fake = new FakeS3();
    fake.overrides.ListObjectsV2 = (input, f) => {
      const res = f.handle("ListObjectsV2", input) as Record<string, unknown>;
      if (input.MaxKeys === undefined)
        return { ...res, IsTruncated: true, NextContinuationToken: undefined };
      return res;
    };
    const tracker = new ResourceTracker(PREFIX);
    const stats = new CleanupStats();
    const d = { send: fake.send as unknown as Send, bucket: "b", tracker, concurrency: 1 };
    await sweepRunPrefix(d, stats);
    await findRemaining(d, stats);
    expect(stats.errors.some((e) => /continuation token/.test(e.message))).toBe(true);
    expect(stats.toReport([], 0).status).toBe("failed");
  });
});

describe("observer callbacks", () => {
  const writer: Check = {
    id: "writer",
    name: "Writer",
    description: "w",
    required: true,
    async run(ctx) {
      const key = ctx.key("x.bin");
      await ctx.send(
        new PutObjectCommand({ Bucket: ctx.bucket, Key: key, Body: Buffer.from("x") }),
      );
    },
  };

  it("a throwing logger does not prevent cleanup", async () => {
    const fake = new FakeS3();
    const report = await run(
      fake,
      {
        logger: () => {
          throw new Error("logger broke");
        },
      },
      [writer],
    );
    expect(report.checks[0]?.status).toBe("passed");
    expect(fake.objects.size).toBe(0);
  });

  it("a throwing onCheckComplete does not prevent cleanup", async () => {
    const fake = new FakeS3();
    const report = await run(
      fake,
      {
        onCheckComplete: () => {
          throw new Error("callback broke");
        },
      },
      [writer],
    );
    expect(report.ok).toBe(true);
    expect(fake.objects.size).toBe(0);
  });
});

describe("bounded preflight", () => {
  it("times out a credential provider that never resolves", async () => {
    const fake = new FakeS3();
    (fake.config as { credentials: () => Promise<never> }).credentials = () =>
      new Promise(() => undefined);
    const started = Date.now();
    await expect(run(fake, { timeoutMs: 100 })).rejects.toMatchObject({
      name: "EnvironmentError",
      detail: { kind: "timeout" },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports an abort during preflight as RunAbortedError", async () => {
    const fake = new FakeS3();
    const controller = new AbortController();
    fake.overrides.HeadBucket = () => {
      controller.abort();
      return new Promise(() => undefined);
    };
    await expect(run(fake, { signal: controller.signal })).rejects.toBeInstanceOf(RunAbortedError);
    await expect(run(fake, { signal: controller.signal })).rejects.not.toBeInstanceOf(
      EnvironmentError,
    );
  });
});

describe("check strictness", () => {
  it("checksum: a 403 for the mismatching upload is not proof of validation", async () => {
    const fake = new FakeS3();
    fake.overrides.PutObject = (input, f) => {
      if ((input.Key as string).endsWith("mismatch.bin")) throw s3Error(403, "AccessDenied");
      return f.handle("PutObject", input);
    };
    const report = await run(fake, { checks: ["checksum"] });
    expect(report.checks[0]).toMatchObject({ status: "failed", error: { kind: "assertion" } });
  });

  it("checksum: claiming support via PutObject and accepting a bad checksum fails", async () => {
    const fake = new FakeS3();
    fake.overrides.PutObject = (input, f) => {
      const { ChecksumSHA256, ...rest } = input;
      const res = f.handle("PutObject", rest) as Record<string, unknown>;
      return ChecksumSHA256 ? { ...res, ChecksumSHA256 } : res;
    };
    fake.overrides.HeadObject = (input, f) => {
      const res = f.handle("HeadObject", input) as Record<string, unknown>;
      delete res.ChecksumSHA256;
      return res;
    };
    const report = await run(fake, { checks: ["checksum"] });
    expect(report.checks[0]?.status).toBe("failed");
  });

  it("list: pages smaller than MaxKeys are legitimate", async () => {
    const fake = new FakeS3();
    fake.overrides.ListObjectsV2 = (input, f) =>
      f.handle("ListObjectsV2", input.MaxKeys === 2 ? { ...input, MaxKeys: 1 } : input);
    const report = await run(fake, { checks: ["list"] });
    expect(report.checks[0]?.status).toBe("passed");
    expect(report.checks[0]?.details?.join(" ")).toMatch(/5 pages/);
  });

  it("nonexistent: a HEAD 403 explains the missing s3:ListBucket permission", async () => {
    const fake = new FakeS3();
    fake.overrides.HeadObject = () => {
      throw s3Error(403, "Forbidden", "UnknownError");
    };
    const report = await run(fake, { checks: ["nonexistent"] });
    expect(report.checks[0]?.error?.message).toMatch(/s3:ListBucket/);
    expect(report.checks[0]?.error?.operation).toBe("HeadObject");
  });
});

describe("configuration", () => {
  it("rejects --skip all and normalizes check ids", () => {
    expect(() => resolveConfig({ bucket: "b1", skip: ["all"] }, ["put"], {})).toThrow(ConfigError);
    expect(resolveConfig({ bucket: "b1", checks: [" PUT "] }, ["put", "get"], {}).checkIds).toEqual(
      ["put"],
    );
  });
});

describe("redaction of header-style signing values", () => {
  it.each([
    "X-Amz-Signature: 0123456789abcdef0123456789abcdef",
    '{"X-Amz-Signature":"0123456789abcdef0123456789abcdef"}',
    "<Message>x-amz-signature: 0123456789abcdef0123456789abcdef</Message>",
    "Signature: 0123456789abcdef0123456789abcdef",
    "X-Amz-Credential: ACCESS/20260101/us-east-1/s3/aws4_request",
    "x-amz-security-token: TOKEN0123456789",
  ])("%s", (text) => {
    const out = new Redactor().redact(text);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toMatch(/0123456789abcdef|TOKEN0123456789|aws4_request/);
  });
});

describe("CLI argument errors", () => {
  function capture(env: NodeJS.ProcessEnv): CliIo & { out: () => string; err: () => string } {
    let out = "";
    let err = "";
    return {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      env,
      out: () => out,
      err: () => err,
    };
  }

  it("never echoes secret values passed as argument values", async () => {
    const io = capture(ENV);
    expect(await main(["--bucket", "b1", "--timeout", "SECRET_KEY_EXAMPLE_VALUE"], io)).toBe(2);
    expect(io.err()).not.toContain("SECRET_KEY_EXAMPLE_VALUE");
    const io2 = capture(ENV);
    const url = "https://storage.example.com/b/k?X-Amz-Signature=0123456789abcdef";
    expect(await main(["--bucket", "b1", "--format", url], io2)).toBe(2);
    expect(io2.err()).not.toContain("0123456789abcdef");
  });

  it("emits fatal JSON for parse errors in JSON mode", async () => {
    const io = capture({});
    expect(await main(["--bucket", "b1", "--timeout", "abc", "--format", "json"], io)).toBe(2);
    expect(JSON.parse(io.out())).toMatchObject({ ok: false, error: { type: "config" } });
    const io2 = capture({});
    expect(await main(["--format=json", "--unknown"], io2)).toBe(2);
    expect(JSON.parse(io2.out())).toMatchObject({ ok: false });
  });
});

describe("library output", () => {
  it("does not write SDK warnings to stderr", async () => {
    vi.stubEnv("AWS_PROFILE", "example-profile");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "ACCESS_KEY_EXAMPLE");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "SECRET_KEY_EXAMPLE");
    vi.stubEnv("AWS_CONFIG_FILE", "/nonexistent-s3cc");
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent-s3cc");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runChecksWith(
        { bucket: "test-bucket", endpoint: "http://127.0.0.1:9", timeoutMs: 1000 },
        {},
      ).catch(() => undefined);
      expect(warn).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      write.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
