import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { deterministicBytes } from "../core/data.js";
import { assertEqual, assertStatus, assertTrue, putObject } from "./helpers.js";
import { SMALL_OBJECT_SIZE } from "./put.js";
import type { Check } from "./types.js";

const CONTENT_TYPE = "application/x-s3-compat-check";
const METADATA: Record<string, string> = {
  "s3cc-check": "head",
  "s3cc-sample": "Value-123",
};

export const headCheck: Check = {
  id: "head",
  name: "HeadObject",
  description: "Verify Content-Length, Content-Type and user metadata returned by HEAD",
  required: true,
  async run(ctx) {
    const key = ctx.key("object.bin");
    const body = deterministicBytes(SMALL_OBJECT_SIZE, "head");
    await putObject(ctx, key, body, { ContentType: CONTENT_TYPE, Metadata: METADATA });

    const res = await ctx.send(new HeadObjectCommand({ Bucket: ctx.bucket, Key: key }));
    assertStatus(res.$metadata.httpStatusCode, 200, "HeadObject");
    assertEqual(res.ContentLength, SMALL_OBJECT_SIZE, "Content-Length", "HeadObject");
    assertEqual(res.ContentType, CONTENT_TYPE, "Content-Type", "HeadObject");
    for (const [name, value] of Object.entries(METADATA)) {
      assertEqual(res.Metadata?.[name], value, `Metadata "x-amz-meta-${name}"`, "HeadObject");
    }
    assertTrue(res.ETag, "HeadObject did not return an ETag", "HeadObject");
    assertTrue(
      res.LastModified instanceof Date && !Number.isNaN(res.LastModified.getTime()),
      "HeadObject did not return a valid Last-Modified header",
      "HeadObject",
    );
  },
};
