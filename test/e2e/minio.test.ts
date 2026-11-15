/**
 * End-to-end tests against a disposable MinIO server.
 *
 * Requires a built CLI (`npm run build`) and:
 *   S3CC_E2E_ENDPOINT   (default http://localhost:9000)
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for the MinIO root user
 *
 * The tests create and delete their own buckets, so never point them at a
 * server that holds real data.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunReport } from "../../src/index.js";

const ENDPOINT = process.env.S3CC_E2E_ENDPOINT ?? "http://localhost:9000";
const BIN = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));
const suffix = randomBytes(4).toString("hex");
const BUCKET = `s3cc-e2e-${suffix}`;
const VERSIONED_BUCKET = `s3cc-e2e-v-${suffix}`;
const SENTINEL_KEY = "unrelated/sentinel.txt";

const client = new S3Client({
  region: "us-east-1",
  endpoint: ENDPOINT,
  forcePathStyle: true,
});

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; onStderr?: (chunk: string, kill: () => void) => void } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, NO_COLOR: "1", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      options.onStderr?.(d.toString(), () => child.kill("SIGINT"));
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const baseArgs = (bucket = BUCKET) => [
  "--endpoint",
  ENDPOINT,
  "--bucket",
  bucket,
  "--allow-insecure",
];

async function keysUnder(bucket: string, prefix: string): Promise<string[]> {
  const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return (res.Contents ?? []).map((o) => o.Key as string);
}

async function versionsUnder(bucket: string, prefix: string): Promise<number> {
  const res = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }));
  return (res.Versions?.length ?? 0) + (res.DeleteMarkers?.length ?? 0);
}

async function uploadsUnder(bucket: string, prefix: string): Promise<number> {
  const res = await client.send(
    new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }),
  );
  return res.Uploads?.length ?? 0;
}

async function emptyAndDeleteBucket(bucket: string): Promise<void> {
  const res = await client.send(new ListObjectVersionsCommand({ Bucket: bucket }));
  for (const v of [...(res.Versions ?? []), ...(res.DeleteMarkers ?? [])]) {
    await client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: v.Key, VersionId: v.VersionId }),
    );
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

beforeAll(async () => {
  await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  await client.send(new CreateBucketCommand({ Bucket: VERSIONED_BUCKET }));
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: VERSIONED_BUCKET,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  // Pre-existing data that the tool must never touch.
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: SENTINEL_KEY, Body: "keep me" }));
});

afterAll(async () => {
  await emptyAndDeleteBucket(BUCKET).catch(() => undefined);
  await emptyAndDeleteBucket(VERSIONED_BUCKET).catch(() => undefined);
  client.destroy();
});

describe("MinIO end-to-end", () => {
  it("passes every check, leaves no data behind and keeps unrelated objects", async () => {
    const res = await runCli(baseArgs());
    expect(res.stderr).toBe("");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("S3 Compatibility Check");
    expect(res.stdout).toMatch(/11 passed/);

    expect(await keysUnder(BUCKET, "s3-compat-check/")).toEqual([]);
    expect(await uploadsUnder(BUCKET, "s3-compat-check/")).toBe(0);
    expect(await keysUnder(BUCKET, "unrelated/")).toEqual([SENTINEL_KEY]);
  });

  it("writes a parseable JSON report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s3cc-e2e-"));
    try {
      const file = join(dir, "result.json");
      const res = await runCli([...baseArgs(), "--format", "json", "--output", file]);
      expect(res.code).toBe(0);
      const report = JSON.parse(await readFile(file, "utf8")) as RunReport;
      expect(report).toMatchObject({
        schemaVersion: "1.0",
        tool: "s3-compat-check",
        ok: true,
        aborted: false,
        bucket: BUCKET,
        summary: { total: 11, passed: 11, failed: 0, skipped: 0, unsupported: 0 },
        cleanup: { status: "completed", remaining: [], errors: [] },
      });
      expect(report.checks.map((c) => c.id)).toEqual([
        "put",
        "get",
        "head",
        "delete",
        "range",
        "list",
        "multipart",
        "etag",
        "checksum",
        "presigned",
        "nonexistent",
      ]);
      // The human-readable report still goes to stdout.
      expect(res.stdout).toContain("S3 Compatibility Check");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prints pure JSON to stdout with --format json", async () => {
    const res = await runCli([...baseArgs(), "--format", "json", "--checks", "put,get,head,range"]);
    expect(res.code).toBe(0);
    const report = JSON.parse(res.stdout) as RunReport;
    expect(report.checks.map((c) => c.id)).toEqual(["put", "get", "head", "range"]);
  });

  it("removes all versions and delete markers on a versioned bucket", async () => {
    const res = await runCli([...baseArgs(VERSIONED_BUCKET), "--format", "json"]);
    const report = JSON.parse(res.stdout) as RunReport;
    expect(report.cleanup).toMatchObject({ status: "completed", remaining: [] });
    expect(res.code).toBe(0);
    expect(await versionsUnder(VERSIONED_BUCKET, "s3-compat-check/")).toBe(0);
  });

  it("never prints credentials", async () => {
    const res = await runCli([...baseArgs(), "--verbose", "--format", "json"]);
    const all = res.stdout + res.stderr;
    const secret = process.env.AWS_SECRET_ACCESS_KEY;
    if (secret) expect(all).not.toContain(secret);
    expect(all).not.toMatch(/X-Amz-Signature=[0-9a-f]/i);
    expect(all).not.toMatch(/X-Amz-Credential=/i);
  });

  it("exits with 3 for invalid credentials", async () => {
    const res = await runCli(baseArgs(), {
      env: { AWS_SECRET_ACCESS_KEY: "SECRET_KEY_EXAMPLE_WRONG" },
    });
    expect(res.code).toBe(3);
    expect(res.stderr).toMatch(/denied/i);
    expect(res.stdout + res.stderr).not.toContain("SECRET_KEY_EXAMPLE_WRONG");
  });

  it("exits with 3 for a missing bucket, with a JSON error", async () => {
    const res = await runCli([...baseArgs(`s3cc-missing-${suffix}`), "--format", "json"]);
    expect(res.code).toBe(3);
    const parsed = JSON.parse(res.stdout) as { ok: boolean; error: { type: string } };
    expect(parsed).toMatchObject({ ok: false, error: { type: "environment" } });
  });

  it("exits with 2 for invalid arguments", async () => {
    const res = await runCli([...baseArgs(), "--checks", "does-not-exist"]);
    expect(res.code).toBe(2);
  });

  it("cleans up after SIGINT", async () => {
    const prefix = `s3cc-sigint-${suffix}/`;
    let sent = false;
    const res = await runCli(
      [
        ...baseArgs(),
        "--prefix",
        prefix,
        "--checks",
        "multipart,list",
        "--concurrency",
        "1",
        "--verbose",
      ],
      {
        onStderr: (chunk, kill) => {
          if (!sent && chunk.includes("CreateMultipartUpload ok")) {
            sent = true;
            kill();
          }
        },
      },
    );
    expect(sent).toBe(true);
    expect(res.code).toBe(130);
    expect(res.stderr).toContain("cleaning up");
    expect(await keysUnder(BUCKET, prefix)).toEqual([]);
    expect(await uploadsUnder(BUCKET, prefix)).toBe(0);
  });
});
