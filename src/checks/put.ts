import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { deterministicBytes } from "../core/data.js";
import { assertEqual, assertStatus, putObject } from "./helpers.js";
import type { Check } from "./types.js";

export const SMALL_OBJECT_SIZE = 1024;

export const putCheck: Check = {
  id: "put",
  name: "PutObject",
  description: "Upload a 1 KiB object and verify that it is stored",
  required: true,
  async run(ctx) {
    const key = ctx.key("object.bin");
    const body = deterministicBytes(SMALL_OBJECT_SIZE, "put");

    const res = await putObject(ctx, key, body, { ContentType: "application/octet-stream" });
    assertStatus(res.$metadata.httpStatusCode, 200, "PutObject");

    const head = await ctx.send(new HeadObjectCommand({ Bucket: ctx.bucket, Key: key }));
    assertEqual(head.ContentLength, SMALL_OBJECT_SIZE, "Stored object size", "HeadObject");
  },
};
