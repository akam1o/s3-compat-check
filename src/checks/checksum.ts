import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { deterministicBytes, sha256Base64 } from "../core/data.js";
import {
  AssertionFailure,
  UnsupportedFeature,
  classifyError,
  httpErrorInfo,
} from "../core/errors.js";
import { assertEqual, describeError, expectHttpError, putObject } from "./helpers.js";
import type { Check } from "./types.js";

const SIZE = 2048;
const UNSUPPORTED_CODES = new Set([
  "NotImplemented",
  "InvalidArgument",
  "InvalidRequest",
  "UnsupportedArgument",
]);

/** Codes used by S3 and compatible implementations for a checksum mismatch. */
const CHECKSUM_MISMATCH_CODES = new Set([
  "BadDigest",
  "InvalidDigest",
  "XAmzContentChecksumMismatch",
  "XAmzContentSHA256Mismatch",
]);

/** A rejection of the checksum header itself (as opposed to a broken server). */
function isUnsupportedResponse(error: unknown): boolean {
  const info = httpErrorInfo(error);
  if (!info) return false;
  if (info.httpStatus === 501) return true;
  return info.httpStatus === 400 && info.code !== undefined && UNSUPPORTED_CODES.has(info.code);
}

export const checksumCheck: Check = {
  id: "checksum",
  name: "Checksum",
  description:
    "PUT with x-amz-checksum-sha256, read it back, and verify a wrong checksum is rejected",
  required: false,
  async run(ctx) {
    const body = deterministicBytes(SIZE, "checksum");
    const checksum = sha256Base64(body);

    const key = ctx.key("object.bin");
    let put;
    try {
      put = await putObject(ctx, key, body, { ChecksumSHA256: checksum });
    } catch (error) {
      if (isUnsupportedResponse(error)) {
        const detail = classifyError(error);
        throw new UnsupportedFeature(
          `PutObject with x-amz-checksum-sha256 was rejected (${detail.httpStatus} ${detail.code ?? ""})`.trim(),
          detail,
        );
      }
      throw error;
    }
    if (put.ChecksumSHA256 !== undefined) {
      assertEqual(
        put.ChecksumSHA256,
        checksum,
        "ChecksumSHA256 in PutObject response",
        "PutObject",
      );
    }

    const head = await ctx.send(
      new HeadObjectCommand({ Bucket: ctx.bucket, Key: key, ChecksumMode: "ENABLED" }),
    );
    const returned = head.ChecksumSHA256;
    if (returned !== undefined) {
      assertEqual(returned, checksum, "ChecksumSHA256 returned by HeadObject", "HeadObject");
    } else {
      ctx.note("HeadObject with x-amz-checksum-mode: ENABLED returned no ChecksumSHA256");
    }

    // A server that supports checksums must reject a body that does not match.
    const badKey = ctx.key("mismatch.bin");
    const wrong = sha256Base64(deterministicBytes(SIZE, "checksum-other"));
    let rejected;
    try {
      rejected = await expectHttpError("PutObject with wrong checksum", () =>
        putObject(ctx, badKey, body, { ChecksumSHA256: wrong }),
      );
    } catch (error) {
      // Only call it "unsupported" if the server never claimed checksum support.
      const claimedSupport = put.ChecksumSHA256 !== undefined || returned !== undefined;
      if (error instanceof AssertionFailure && !claimedSupport) {
        throw new UnsupportedFeature(
          "x-amz-checksum-sha256 is accepted but ignored: a mismatching checksum was not rejected and no checksum is returned",
        );
      }
      if (error instanceof AssertionFailure) {
        throw new AssertionFailure(
          "A mismatching x-amz-checksum-sha256 was accepted although the server returns checksums",
          { expected: "400 BadDigest", actual: "success", operation: "PutObject" },
        );
      }
      throw error;
    }
    ctx.note(`PutObject with wrong checksum: ${describeError(rejected)}`);
    // Only a checksum-specific 400 proves validation; 403, 404 or an unrelated
    // 400 (e.g. MalformedXML) says nothing about checksum support.
    if (
      rejected.httpStatus !== 400 ||
      !rejected.code ||
      !CHECKSUM_MISMATCH_CODES.has(rejected.code)
    ) {
      throw new AssertionFailure("Unexpected response to a mismatching checksum", {
        expected: `400 with one of ${[...CHECKSUM_MISMATCH_CODES].join(", ")}`,
        actual: describeError(rejected),
        operation: "PutObject",
      });
    }
  },
};
