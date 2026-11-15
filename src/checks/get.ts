import { GetObjectCommand } from "@aws-sdk/client-s3";
import { deterministicBytes } from "../core/data.js";
import { assertBytesEqual, assertEqual, assertStatus, putObject } from "./helpers.js";
import { SMALL_OBJECT_SIZE } from "./put.js";
import type { Check } from "./types.js";

export const getCheck: Check = {
  id: "get",
  name: "GetObject",
  description: "Download an object and verify its bytes and Content-Length",
  required: true,
  async run(ctx) {
    const key = ctx.key("object.bin");
    const body = deterministicBytes(SMALL_OBJECT_SIZE, "get");
    await putObject(ctx, key, body);

    const res = await ctx.send(new GetObjectCommand({ Bucket: ctx.bucket, Key: key }));
    assertStatus(res.$metadata.httpStatusCode, 200, "GetObject");
    assertEqual(res.ContentLength, SMALL_OBJECT_SIZE, "Content-Length", "GetObject");
    const data = await ctx.readBody(res.Body, "GetObject");
    assertBytesEqual(data, body, "Downloaded body", "GetObject");
  },
};
