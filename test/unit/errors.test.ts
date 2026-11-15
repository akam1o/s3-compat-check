import { describe, expect, it } from "vitest";
import {
  AssertionFailure,
  DeadlineExceededError,
  OperationTimeoutError,
  ResponseError,
  RunAbortedError,
  classifyError,
  tagOperation,
} from "../../src/core/errors.js";
import { s3Error } from "./fake-s3.js";

describe("classifyError", () => {
  it("classifies S3 service errors", () => {
    const err = s3Error(403, "SignatureDoesNotMatch", "The request signature does not match");
    tagOperation(err, "PutObject");
    expect(classifyError(err)).toEqual({
      kind: "http",
      message: "The request signature does not match",
      httpStatus: 403,
      code: "SignatureDoesNotMatch",
      requestId: "REQUESTID-EXAMPLE",
      operation: "PutObject",
    });
  });

  it("drops placeholder codes and messages for body-less responses", () => {
    const err = s3Error(403, "Unknown", "UnknownError");
    expect(classifyError(err)).toMatchObject({
      kind: "http",
      httpStatus: 403,
      message: "HTTP 403",
    });
    expect(classifyError(err).code).toBeUndefined();
  });

  it("classifies network errors, including nested causes", () => {
    const err = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    expect(classifyError(err)).toMatchObject({ kind: "network", code: "ECONNREFUSED" });
    const wrapped = new Error("fetch failed", { cause: { code: "ENOTFOUND" } });
    expect(classifyError(wrapped)).toMatchObject({ kind: "network", code: "ENOTFOUND" });
  });

  it("classifies timeouts and aborts", () => {
    expect(classifyError(new OperationTimeoutError("GetObject", 100))).toEqual({
      kind: "timeout",
      message: "GetObject timed out after 100 ms",
      operation: "GetObject",
    });
    expect(classifyError(new DeadlineExceededError("DeleteObject")).kind).toBe("timeout");
    expect(classifyError(new RunAbortedError("PutObject")).kind).toBe("aborted");
    const sdkTimeout = Object.assign(new Error("socket timeout"), { name: "TimeoutError" });
    expect(classifyError(sdkTimeout).kind).toBe("timeout");
  });

  it("keeps assertion expectations", () => {
    const e = classifyError(
      new AssertionFailure("Content-Range does not match", {
        expected: "bytes 0-99/1024",
        actual: undefined,
        operation: "GetObject",
      }),
    );
    expect(e).toEqual({
      kind: "assertion",
      message: "Content-Range does not match",
      expected: '"bytes 0-99/1024"',
      actual: "(missing)",
      operation: "GetObject",
    });
  });

  it("uses ResponseError details verbatim", () => {
    const e = classifyError(
      new ResponseError("x", {
        kind: "http",
        message: "denied",
        httpStatus: 403,
        code: "AccessDenied",
      }),
    );
    expect(e).toEqual({ kind: "http", message: "denied", httpStatus: 403, code: "AccessDenied" });
  });

  it("handles non-error values", () => {
    expect(classifyError("boom")).toEqual({ kind: "unknown", message: "boom" });
  });

  it("never copies raw SDK fields such as $response", () => {
    const err = Object.assign(s3Error(500, "InternalError"), {
      $response: { headers: { authorization: "AWS4-HMAC-SHA256 Credential=SECRET" } },
    });
    expect(JSON.stringify(classifyError(err))).not.toContain("SECRET");
  });
});
