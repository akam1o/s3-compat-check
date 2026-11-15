import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { deterministicBytes, md5Hex } from "../core/data.js";
import {
  assertEqual,
  assertStatus,
  assertTrue,
  describeError,
  expectHttpError,
  putObject,
} from "./helpers.js";
import { SMALL_OBJECT_SIZE } from "./put.js";
import type { Check } from "./types.js";

export const etagCheck: Check = {
  id: "etag",
  name: "ETag",
  description: "Verify ETag consistency across PUT/HEAD/GET and conditional requests",
  required: true,
  async run(ctx) {
    const key = ctx.key("object.bin");
    const body = deterministicBytes(SMALL_OBJECT_SIZE, "etag");
    const put = await putObject(ctx, key, body);
    const etag = put.ETag;
    assertTrue(etag, "PutObject did not return an ETag", "PutObject");

    // The ETag is opaque: it is NOT required to be the MD5 of the content.
    const isMd5 = etag === `"${md5Hex(body)}"`;
    ctx.note(
      isMd5 ? "ETag equals the quoted MD5 of the content" : "ETag is not the MD5 of the content",
    );

    const head = await ctx.send(new HeadObjectCommand({ Bucket: ctx.bucket, Key: key }));
    assertEqual(head.ETag, etag, "HeadObject ETag vs PutObject ETag", "HeadObject");

    const get = await ctx.send(new GetObjectCommand({ Bucket: ctx.bucket, Key: key }));
    await ctx.readBody(get.Body, "GetObject");
    assertEqual(get.ETag, etag, "GetObject ETag vs PutObject ETag", "GetObject");

    const head2 = await ctx.send(new HeadObjectCommand({ Bucket: ctx.bucket, Key: key }));
    assertEqual(head2.ETag, etag, "ETag on a repeated HeadObject", "HeadObject");

    const op = "GetObject If-Match";
    const match = await ctx.send(
      new GetObjectCommand({ Bucket: ctx.bucket, Key: key, IfMatch: etag }),
    );
    await ctx.readBody(match.Body, op);
    assertStatus(match.$metadata.httpStatusCode, 200, op);

    const notModified = await expectHttpError("GetObject If-None-Match", () =>
      ctx.send(new GetObjectCommand({ Bucket: ctx.bucket, Key: key, IfNoneMatch: etag })),
    );
    assertEqual(
      notModified.httpStatus,
      304,
      `HTTP status (got ${describeError(notModified)})`,
      "GetObject If-None-Match",
    );

    const mismatch = await expectHttpError("GetObject If-Match (wrong ETag)", () =>
      ctx.send(
        new GetObjectCommand({
          Bucket: ctx.bucket,
          Key: key,
          IfMatch: '"00000000000000000000000000000000"',
        }),
      ),
    );
    assertEqual(
      mismatch.httpStatus,
      412,
      `HTTP status (got ${describeError(mismatch)})`,
      "GetObject If-Match (wrong ETag)",
    );
  },
};
