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
      if (error instanceof AssertionFailure && returned === undefined) {
        throw new UnsupportedFeature(
          "x-amz-checksum-sha256 is accepted but ignored: a mismatching checksum was not rejected and no checksum is returned",
        );
      }
      throw error;
    }
    ctx.note(`PutObject with wrong checksum: ${describeError(rejected)}`);
    if (rejected.httpStatus < 400 || rejected.httpStatus >= 500) {
      throw new AssertionFailure("Unexpected response to a mismatching checksum", {
        expected: "4xx (e.g. 400 BadDigest)",
        actual: describeError(rejected),
        operation: "PutObject",
      });
    }
  },
};
