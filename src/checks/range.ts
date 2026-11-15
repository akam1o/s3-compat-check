import { GetObjectCommand } from "@aws-sdk/client-s3";
import { deterministicBytes } from "../core/data.js";
import { assertBytesEqual, assertEqual, assertStatus, putObject } from "./helpers.js";
import { SMALL_OBJECT_SIZE } from "./put.js";
import type { Check } from "./types.js";

interface RangeCase {
  header: string;
  start: number;
  end: number;
}

const SIZE = SMALL_OBJECT_SIZE;
const CASES: RangeCase[] = [
  { header: "bytes=0-99", start: 0, end: 99 },
  { header: "bytes=100-199", start: 100, end: 199 },
  { header: "bytes=-100", start: SIZE - 100, end: SIZE - 1 },
];

export const rangeCheck: Check = {
  id: "range",
  name: "Range GET",
  description: "Fetch byte ranges and verify status 206, Content-Range and data",
  required: true,
  async run(ctx) {
    const key = ctx.key("object.bin");
    const body = deterministicBytes(SIZE, "range");
    await putObject(ctx, key, body);

    for (const c of CASES) {
      const op = `GetObject Range: ${c.header}`;
      const res = await ctx.send(
        new GetObjectCommand({ Bucket: ctx.bucket, Key: key, Range: c.header }),
      );
      assertStatus(res.$metadata.httpStatusCode, 206, op);
      assertEqual(res.ContentRange, `bytes ${c.start}-${c.end}/${SIZE}`, "Content-Range", op);
      assertEqual(res.ContentLength, c.end - c.start + 1, "Content-Length", op);
      const data = await ctx.readBody(res.Body, op);
      assertBytesEqual(data, body.subarray(c.start, c.end + 1), "Range body", op);
    }
  },
};
