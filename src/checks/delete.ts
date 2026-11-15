import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { deterministicBytes } from "../core/data.js";
import { assertEqual, assertStatus, describeError, expectHttpError, putObject } from "./helpers.js";
import { SMALL_OBJECT_SIZE } from "./put.js";
import type { Check } from "./types.js";

export const deleteCheck: Check = {
  id: "delete",
  name: "DeleteObject",
  description: "Delete an object and verify that GET and HEAD then return 404",
  required: true,
  async run(ctx) {
    const key = ctx.key("object.bin");
    await putObject(ctx, key, deterministicBytes(SMALL_OBJECT_SIZE, "delete"));

    const res = await ctx.send(new DeleteObjectCommand({ Bucket: ctx.bucket, Key: key }));
    ctx.recordDelete(key, res.VersionId);
    assertStatus(res.$metadata.httpStatusCode, [204, 200], "DeleteObject");
    if (res.$metadata.httpStatusCode !== 204) {
      ctx.note(`DeleteObject returned ${res.$metadata.httpStatusCode} (AWS S3 returns 204)`);
    }

    const get = await expectHttpError("GetObject after delete", () =>
      ctx.send(new GetObjectCommand({ Bucket: ctx.bucket, Key: key })),
    );
    ctx.note(`GetObject after delete: ${describeError(get)}`);
    assertEqual(get.httpStatus, 404, "HTTP status of GetObject after delete", "GetObject");
    assertEqual(get.code, "NoSuchKey", "Error code of GetObject after delete", "GetObject");

    const head = await expectHttpError("HeadObject after delete", () =>
      ctx.send(new HeadObjectCommand({ Bucket: ctx.bucket, Key: key })),
    );
    ctx.note(`HeadObject after delete: ${describeError(head)}`);
    assertEqual(head.httpStatus, 404, "HTTP status of HeadObject after delete", "HeadObject");

    // S3 treats deleting a missing key as success.
    const again = await ctx.send(new DeleteObjectCommand({ Bucket: ctx.bucket, Key: key }));
    ctx.recordDelete(key, again.VersionId);
    assertStatus(again.$metadata.httpStatusCode, [204, 200], "DeleteObject (already deleted)");
  },
};
