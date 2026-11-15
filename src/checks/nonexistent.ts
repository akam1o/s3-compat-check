import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { AssertionFailure } from "../core/errors.js";
import { assertEqual, describeError, expectHttpError } from "./helpers.js";
import type { Check } from "./types.js";

export const nonexistentCheck: Check = {
  id: "nonexistent",
  name: "Nonexistent Object",
  description: "GET and HEAD a missing key and verify 404 / NoSuchKey",
  required: true,
  async run(ctx) {
    const key = ctx.unusedKey("missing");

    const get = await expectHttpError("GetObject", () =>
      ctx.send(new GetObjectCommand({ Bucket: ctx.bucket, Key: key })),
    );
    ctx.note(`GetObject: HTTP ${get.httpStatus}, code ${get.code ?? "(none)"}`);

    const head = await expectHttpError("HeadObject", () =>
      ctx.send(new HeadObjectCommand({ Bucket: ctx.bucket, Key: key })),
    );
    ctx.note(`HeadObject: HTTP ${head.httpStatus}, code ${head.code ?? "(none)"}`);

    if (get.httpStatus === 403) {
      throw new AssertionFailure(
        "GetObject on a missing key returned 403; S3 does this when s3:ListBucket is not granted",
        { expected: "404 NoSuchKey", actual: describeError(get), operation: "GetObject" },
      );
    }
    assertEqual(get.httpStatus, 404, "HTTP status of GetObject", "GetObject");
    assertEqual(get.code, "NoSuchKey", "Error code of GetObject", "GetObject");
    // HEAD responses have no body, so only the status is meaningful.
    assertEqual(head.httpStatus, 404, "HTTP status of HeadObject", "HeadObject");
  },
};
