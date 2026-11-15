import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { deterministicBytes } from "../core/data.js";
import { mapWithConcurrency } from "../core/pool.js";
import { AssertionFailure } from "../core/errors.js";
import { assertEqual, assertStatus, assertTrue, putObject } from "./helpers.js";
import type { Check } from "./types.js";

const PAGE_SIZE = 2;
const MAX_PAGES = 10;

export const listCheck: Check = {
  id: "list",
  name: "ListObjectsV2",
  description: "List objects with Prefix, Delimiter and MaxKeys pagination",
  required: true,
  async run(ctx) {
    // Five keys under "a/" (three pages of two) and two decoys under "b/".
    const names = [
      ...Array.from({ length: 5 }, (_, i) => `a/key-${i}`),
      ...Array.from({ length: 2 }, (_, i) => `b/key-${i}`),
    ];
    const objects = names.map((name, i) => ({ key: ctx.key(name), size: 10 + i }));
    await mapWithConcurrency(objects, 4, (o) =>
      putObject(ctx, o.key, deterministicBytes(o.size, o.key)),
    );

    const prefixA = `${ctx.prefix}a/`;
    const expected = objects.filter((o) => o.key.startsWith(prefixA));
    const expectedKeys = expected.map((o) => o.key).sort();

    // Paginated listing restricted to "a/".
    const seen: string[] = [];
    let token: string | undefined;
    let pages = 0;
    for (;;) {
      pages++;
      if (pages > MAX_PAGES) {
        throw new AssertionFailure("Pagination did not terminate", {
          expected: `<= ${Math.ceil(expectedKeys.length / PAGE_SIZE)} pages`,
          actual: `> ${MAX_PAGES} pages`,
          operation: "ListObjectsV2",
        });
      }
      const op = `ListObjectsV2 page ${pages}`;
      const res = await ctx.send(
        new ListObjectsV2Command({
          Bucket: ctx.bucket,
          Prefix: prefixA,
          MaxKeys: PAGE_SIZE,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      assertStatus(res.$metadata.httpStatusCode, 200, op);
      const contents = res.Contents ?? [];
      assertTrue(
        contents.length <= PAGE_SIZE,
        `${op} returned ${contents.length} keys with MaxKeys=${PAGE_SIZE}`,
        op,
      );
      if (res.KeyCount !== undefined) {
        assertEqual(res.KeyCount, contents.length, "KeyCount", op);
      } else {
        ctx.note("ListObjectsV2 response has no KeyCount");
      }
      for (const obj of contents) {
        const exp = expected.find((o) => o.key === obj.Key);
        if (!exp) {
          throw new AssertionFailure(`${op} returned a key outside the requested prefix`, {
            expected: `keys starting with ${JSON.stringify(prefixA)}`,
            actual: obj.Key,
            operation: op,
          });
        }
        assertEqual(obj.Size, exp.size, `Size of ${obj.Key}`, op);
        seen.push(obj.Key as string);
      }
      if (!res.IsTruncated) break;
      assertTrue(
        res.NextContinuationToken,
        `${op} has IsTruncated=true but no NextContinuationToken`,
        op,
      );
      token = res.NextContinuationToken;
    }
    assertEqual(
      JSON.stringify(seen),
      JSON.stringify(expectedKeys),
      "Listed keys (in order)",
      "ListObjectsV2",
    );
    assertEqual(
      pages,
      Math.ceil(expectedKeys.length / PAGE_SIZE),
      "Number of pages",
      "ListObjectsV2",
    );

    // Delimiter listing: "a/" and "b/" must be rolled up into CommonPrefixes.
    const op = "ListObjectsV2 with Delimiter";
    const res = await ctx.send(
      new ListObjectsV2Command({ Bucket: ctx.bucket, Prefix: ctx.prefix, Delimiter: "/" }),
    );
    const common = (res.CommonPrefixes ?? []).map((p) => p.Prefix).sort();
    assertEqual(
      JSON.stringify(common),
      JSON.stringify([`${ctx.prefix}a/`, `${ctx.prefix}b/`]),
      "CommonPrefixes",
      op,
    );
    assertEqual(res.Contents?.length ?? 0, 0, "Number of keys directly under the prefix", op);
  },
};
