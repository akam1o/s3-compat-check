import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { deterministicBytes } from "../core/data.js";
import { ResponseError } from "../core/errors.js";
import { withTimeout } from "../core/timeout.js";
import { assertBytesEqual, putObject } from "./helpers.js";
import { SMALL_OBJECT_SIZE } from "./put.js";
import type { Check } from "./types.js";

const EXPIRES_IN_SECONDS = 60;
const OPERATION = "GET presigned URL";

function xmlTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([^<]{1,256})</${tag}>`).exec(xml);
  return m?.[1];
}

export const presignedCheck: Check = {
  id: "presigned",
  name: "Presigned URL",
  description: "Generate a presigned GET URL and download it without SDK or auth headers",
  required: true,
  async run(ctx) {
    const key = ctx.key("object.bin");
    const body = deterministicBytes(SMALL_OBJECT_SIZE, "presigned");
    await putObject(ctx, key, body);

    // The URL is a bearer credential: it is never logged or returned.
    // Signing may need a credential refresh, so it is bounded like any request.
    const url = await withTimeout("Presign GetObject", ctx.timeoutMs, ctx.signal, () =>
      getSignedUrl(ctx.client, new GetObjectCommand({ Bucket: ctx.bucket, Key: key }), {
        expiresIn: EXPIRES_IN_SECONDS,
      }),
    );

    const { response, body: data } = await ctx.fetch(
      url,
      { method: "GET", redirect: "manual" },
      OPERATION,
    );
    if (response.status !== 200) {
      // Only extract the error code and message: S3 error bodies for signature
      // errors may echo the string-to-sign and the access key id.
      const text = data.toString("utf8");
      const code = xmlTag(text, "Code");
      const message = xmlTag(text, "Message");
      throw new ResponseError(`${OPERATION} returned HTTP ${response.status}`, {
        kind: "http",
        message: message ?? `HTTP ${response.status}`,
        operation: OPERATION,
        httpStatus: response.status,
        ...(code ? { code } : {}),
      });
    }
    assertBytesEqual(data, body, "Presigned GET body", OPERATION);
  },
};
