import { describe, expect, it } from "vitest";
import type { RunReport } from "../../src/core/result.js";
import { isRunSuccessful, summarize } from "../../src/core/result.js";
import { fatalReport, formatFatalJson, formatJson } from "../../src/reporters/json.js";
import { errorLabel, formatCheckList, formatText } from "../../src/reporters/text.js";

function sampleReport(overrides: Partial<RunReport> = {}): RunReport {
  const checks: RunReport["checks"] = [
    { id: "put", name: "PutObject", status: "passed", required: true, durationMs: 42 },
    {
      id: "checksum",
      name: "Checksum",
      status: "unsupported",
      required: false,
      durationMs: 3,
      error: { kind: "http", message: "rejected", httpStatus: 501, code: "NotImplemented" },
    },
    {
      id: "presigned",
      name: "Presigned URL",
      status: "failed",
      required: true,
      durationMs: 10,
      error: {
        kind: "http",
        message: "The request signature we calculated does not match",
        httpStatus: 403,
        code: "SignatureDoesNotMatch",
        operation: "GET presigned URL",
      },
      details: ["a detail"],
    },
  ];
  return {
    schemaVersion: "1.0",
    tool: "s3-compat-check",
    toolVersion: "0.0.0-test",
    ok: false,
    aborted: false,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.200Z",
    durationMs: 1200,
    endpoint: "http://localhost:9000",
    bucket: "test-bucket",
    region: "us-east-1",
    addressingStyle: "path",
    runPrefix: "s3-compat-check/20260101T000000Z-0123abcd/",
    environment: { node: "v22.0.0", platform: "linux", arch: "x64", awsSdkVersion: "3.0.0" },
    summary: summarize(checks),
    checks,
    cleanup: {
      status: "completed",
      deletedObjects: 3,
      abortedUploads: 0,
      remaining: [],
      errors: [],
      warnings: [],
      durationMs: 5,
    },
    ...overrides,
  };
}

describe("summarize / isRunSuccessful", () => {
  it("counts statuses", () => {
    expect(sampleReport().summary).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 0,
      unsupported: 1,
    });
  });

  it("treats unsupported and skipped as non-failing", () => {
    const cleanup = sampleReport().cleanup;
    expect(
      isRunSuccessful(
        { total: 2, passed: 1, failed: 0, skipped: 0, unsupported: 1 },
        cleanup,
        false,
      ),
    ).toBe(true);
    expect(
      isRunSuccessful(
        { total: 1, passed: 0, failed: 0, skipped: 1, unsupported: 0 },
        cleanup,
        false,
      ),
    ).toBe(true);
    expect(
      isRunSuccessful(
        { total: 1, passed: 0, failed: 1, skipped: 0, unsupported: 0 },
        cleanup,
        false,
      ),
    ).toBe(false);
    expect(
      isRunSuccessful(
        { total: 1, passed: 1, failed: 0, skipped: 0, unsupported: 0 },
        { ...cleanup, status: "failed" },
        false,
      ),
    ).toBe(false);
    expect(
      isRunSuccessful(
        { total: 1, passed: 1, failed: 0, skipped: 0, unsupported: 0 },
        cleanup,
        true,
      ),
    ).toBe(false);
  });
});

describe("text reporter", () => {
  it("renders the documented layout without colors", () => {
    const text = formatText(sampleReport());
    expect(text).toBe(
      [
        "S3 Compatibility Check",
        "",
        "Endpoint: http://localhost:9000",
        "Bucket:   test-bucket",
        "Region:   us-east-1",
        "",
        "✓ PutObject                   42 ms",
        "- Checksum                unsupported",
        "✗ Presigned URL           403 SignatureDoesNotMatch",
        "",
        "Failures:",
        "  ✗ Presigned URL (presigned)",
        "      GET presigned URL: The request signature we calculated does not match (HTTP 403 SignatureDoesNotMatch)",
        "",
        "Unsupported (optional features):",
        "  - Checksum: rejected",
        "",
        "1 passed, 1 failed, 1 unsupported",
        "Duration: 1.2 s",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("\u001b[");
  });

  it("adds colors only when asked", () => {
    expect(formatText(sampleReport(), { color: true })).toContain("\u001b[32m");
  });

  it("shows details, prefix and cleanup in verbose mode", () => {
    const text = formatText(sampleReport(), { verbose: true });
    expect(text).toContain("Prefix:   s3-compat-check/20260101T000000Z-0123abcd/");
    expect(text).toContain("    - a detail");
    expect(text).toContain("Cleanup: completed (3 object(s) deleted, 0 upload(s) aborted)");
  });

  it("always shows cleanup failures", () => {
    const report = sampleReport({
      cleanup: {
        status: "failed",
        deletedObjects: 0,
        abortedUploads: 0,
        remaining: ["s3-compat-check/20260101T000000Z-0123abcd/put/object.bin"],
        errors: [
          {
            operation: "DeleteObject",
            message: "Access Denied",
            httpStatus: 403,
            code: "AccessDenied",
          },
        ],
        warnings: [],
        durationMs: 1,
      },
    });
    const text = formatText(report);
    expect(text).toContain("Cleanup FAILED");
    expect(text).toContain("remaining: s3-compat-check/20260101T000000Z-0123abcd/put/object.bin");
    expect(text).toContain("DeleteObject: Access Denied (HTTP 403 AccessDenied)");
  });

  it("labels failure kinds", () => {
    expect(errorLabel({ kind: "timeout", message: "" })).toBe("timeout");
    expect(errorLabel({ kind: "network", message: "", code: "ECONNREFUSED" })).toBe(
      "network error ECONNREFUSED",
    );
    expect(errorLabel({ kind: "assertion", message: "" })).toBe("assertion failed");
    expect(errorLabel({ kind: "http", message: "", httpStatus: 500 })).toBe("500");
  });

  it("lists checks", () => {
    const text = formatCheckList([
      { id: "put", name: "PutObject", description: "Upload", required: true },
      { id: "checksum", name: "Checksum", description: "Checksums", required: false },
    ]);
    expect(text).toBe("put       Upload\nchecksum  Checksums (optional)\n");
  });
});

describe("json reporter", () => {
  it("emits parseable JSON with the stable top-level schema", () => {
    const parsed = JSON.parse(formatJson(sampleReport())) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "schemaVersion",
      "tool",
      "toolVersion",
      "ok",
      "aborted",
      "startedAt",
      "finishedAt",
      "durationMs",
      "endpoint",
      "bucket",
      "region",
      "addressingStyle",
      "runPrefix",
      "environment",
      "summary",
      "checks",
      "cleanup",
    ]);
    expect(parsed.summary).toEqual({ total: 3, passed: 1, failed: 1, skipped: 0, unsupported: 1 });
  });

  it("emits fatal reports", () => {
    const parsed = JSON.parse(formatFatalJson(fatalReport("config", "bad"))) as Record<
      string,
      unknown
    >;
    expect(parsed).toMatchObject({
      schemaVersion: "1.0",
      ok: false,
      error: { type: "config", message: "bad" },
    });
  });
});
