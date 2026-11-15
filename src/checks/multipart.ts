import { createHash } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { deterministicBytes } from "../core/data.js";
import { classifyError } from "../core/errors.js";
import { assertEqual, assertStatus, assertTrue } from "./helpers.js";
import type { Check } from "./types.js";

const MIB = 1024 * 1024;
/** S3 minimum part size for all parts but the last. */
export const PART_SIZES = [5 * MIB, 1 * MIB + 123];

export const multipartCheck: Check = {
  id: "multipart",
  name: "Multipart Upload",
  description: "Upload a 2-part object (5 MiB + 1 MiB) and verify the assembled data",
  required: true,
  async run(ctx) {
    const key = ctx.key("multipart.bin");
    const totalSize = PART_SIZES.reduce((a, b) => a + b, 0);
    const expectedHash = createHash("sha256");

    const created = await ctx.send(
      new CreateMultipartUploadCommand({
        Bucket: ctx.bucket,
        Key: key,
        ContentType: "application/octet-stream",
      }),
    );
    const uploadId = created.UploadId;
    assertTrue(
      uploadId,
      "CreateMultipartUpload did not return an UploadId",
      "CreateMultipartUpload",
    );
    ctx.trackUpload(key, uploadId as string);

    let completed = false;
    try {
      const parts: CompletedPart[] = [];
      // Parts are generated and uploaded one at a time to bound memory use.
      for (const [index, size] of PART_SIZES.entries()) {
        const partNumber = index + 1;
        const data = deterministicBytes(size, `multipart-${partNumber}`);
        expectedHash.update(data);
        const op = `UploadPart ${partNumber}`;
        const res = await ctx.send(
          new UploadPartCommand({
            Bucket: ctx.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: data,
            ContentLength: data.length,
          }),
        );
        assertStatus(res.$metadata.httpStatusCode, 200, op);
        assertTrue(res.ETag, `${op} did not return an ETag`, op);
        parts.push({ PartNumber: partNumber, ETag: res.ETag });
      }

      const done = await ctx.send(
        new CompleteMultipartUploadCommand({
          Bucket: ctx.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
      completed = true;
      ctx.untrackUpload(uploadId as string);
      ctx.recordWrite(key, done.VersionId);
      assertStatus(done.$metadata.httpStatusCode, 200, "CompleteMultipartUpload");
      if (done.ETag) {
        const multipartStyle = /^"?[0-9a-f]{32}-\d+"?$/i.test(done.ETag);
        ctx.note(
          multipartStyle
            ? `Multipart ETag uses the "<md5>-<parts>" format`
            : `Multipart ETag does not use the "<md5>-<parts>" format`,
        );
      } else {
        ctx.note("CompleteMultipartUpload did not return an ETag");
      }
    } catch (error) {
      if (!completed) {
        try {
          await ctx.send(
            new AbortMultipartUploadCommand({ Bucket: ctx.bucket, Key: key, UploadId: uploadId }),
          );
          ctx.untrackUpload(uploadId as string);
        } catch (abortError) {
          // The runner's cleanup retries the abort; just record why it failed here.
          ctx.note(`AbortMultipartUpload failed: ${classifyError(abortError).message}`);
        }
      }
      throw error;
    }

    const head = await ctx.send(new HeadObjectCommand({ Bucket: ctx.bucket, Key: key }));
    assertEqual(
      head.ContentLength,
      totalSize,
      "Content-Length of the assembled object",
      "HeadObject",
    );

    const get = await ctx.send(new GetObjectCommand({ Bucket: ctx.bucket, Key: key }));
    assertStatus(get.$metadata.httpStatusCode, 200, "GetObject");
    const actualHash = createHash("sha256");
    const length = await ctx.consumeBody(get.Body, "GetObject", (chunk) =>
      actualHash.update(chunk),
    );
    assertEqual(length, totalSize, "Downloaded size", "GetObject");
    assertEqual(
      actualHash.digest("hex"),
      expectedHash.digest("hex"),
      "SHA-256 of the downloaded object",
      "GetObject",
    );
  },
};
