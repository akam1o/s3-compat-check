import { PutObjectCommand, type PutObjectCommandInput } from "@aws-sdk/client-s3";
import type { CheckContext } from "../core/context.js";
import { firstDifference } from "../core/data.js";
import { AssertionFailure, httpErrorInfo } from "../core/errors.js";

export function assertEqual<T>(actual: T, expected: T, what: string, operation?: string): void {
  if (actual !== expected) {
    throw new AssertionFailure(`${what} does not match`, {
      expected,
      actual,
      ...(operation ? { operation } : {}),
    });
  }
}

export function assertTrue(condition: unknown, message: string, operation?: string): void {
  if (!condition) throw new AssertionFailure(message, operation ? { operation } : {});
}

export function assertStatus(
  actual: number | undefined,
  expected: number | readonly number[],
  operation: string,
): void {
  const allowed = typeof expected === "number" ? [expected] : expected;
  if (actual === undefined || !allowed.includes(actual)) {
    throw new AssertionFailure(`${operation} returned an unexpected HTTP status`, {
      expected: allowed.join(" or "),
      actual,
      operation,
    });
  }
}

export function assertBytesEqual(
  actual: Uint8Array,
  expected: Uint8Array,
  what: string,
  operation?: string,
): void {
  const diff = firstDifference(actual, expected);
  if (diff === -1) return;
  const detail =
    actual.length !== expected.length
      ? `length ${actual.length}, expected ${expected.length}`
      : `first difference at byte offset ${diff}`;
  throw new AssertionFailure(`${what} differs from the uploaded data (${detail})`, {
    expected: `${expected.length} bytes`,
    actual: `${actual.length} bytes`,
    ...(operation ? { operation } : {}),
  });
}

export interface ObservedError {
  httpStatus: number;
  code?: string;
}

/**
 * Expect `fn` to fail with an HTTP error response. Network errors and
 * timeouts are re-thrown so that they are reported as such.
 */
export async function expectHttpError(
  operation: string,
  fn: () => Promise<unknown>,
): Promise<ObservedError> {
  try {
    await fn();
  } catch (error) {
    const info = httpErrorInfo(error);
    if (!info) throw error;
    return { httpStatus: info.httpStatus, ...(info.code ? { code: info.code } : {}) };
  }
  throw new AssertionFailure(`${operation} unexpectedly succeeded`, {
    expected: "an error response",
    actual: "success",
    operation,
  });
}

export function describeError(e: ObservedError): string {
  return e.code ? `${e.httpStatus} ${e.code}` : `${e.httpStatus}`;
}

export async function putObject(
  ctx: CheckContext,
  key: string,
  body: Uint8Array,
  extra: Partial<PutObjectCommandInput> = {},
) {
  const res = await ctx.send(
    new PutObjectCommand({
      Bucket: ctx.bucket,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ...extra,
    }),
  );
  ctx.recordWrite(key, res.VersionId);
  return res;
}
