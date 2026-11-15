import { createHash } from "node:crypto";
import { Readable } from "node:stream";

/** Minimal in-memory S3 used to unit test checks and the runner. */

interface StoredObject {
  body: Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
  etag: string;
  checksumSha256?: string;
}

export type Handler = (input: Record<string, unknown>, fake: FakeS3) => unknown;

export function s3Error(httpStatusCode: number, code: string, message = code): Error {
  return Object.assign(new Error(message), {
    name: code,
    Code: code,
    $fault: httpStatusCode >= 500 ? "server" : "client",
    $metadata: { httpStatusCode, requestId: "REQUESTID-EXAMPLE" },
  });
}

const ok = (status = 200) => ({ $metadata: { httpStatusCode: status } });

export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  readonly calls: string[] = [];
  readonly overrides: Partial<Record<string, Handler>> = {};
  private uploadSeq = 0;

  readonly config = {
    credentials: async () => ({
      accessKeyId: "ACCESS_KEY_EXAMPLE",
      secretAccessKey: "SECRET_KEY_EXAMPLE_VALUE",
    }),
  };

  send = async (command: { constructor: { name: string }; input: unknown }): Promise<unknown> => {
    const op = command.constructor.name.replace(/Command$/, "");
    const input = command.input as Record<string, unknown>;
    this.calls.push(op);
    const override = this.overrides[op];
    if (override) return override(input, this);
    return this.handle(op, input);
  };

  handle(op: string, input: Record<string, unknown>): unknown {
    const key = input.Key as string;
    switch (op) {
      case "HeadBucket":
        return ok();
      case "PutObject": {
        const body = Buffer.from(input.Body as Uint8Array);
        const sha = createHash("sha256").update(body).digest("base64");
        if (input.ChecksumSHA256 !== undefined && input.ChecksumSHA256 !== sha) {
          throw s3Error(400, "BadDigest");
        }
        const etag = `"${createHash("md5").update(body).digest("hex")}"`;
        this.objects.set(key, {
          body,
          etag,
          ...(input.ContentType ? { contentType: input.ContentType as string } : {}),
          ...(input.Metadata ? { metadata: input.Metadata as Record<string, string> } : {}),
          ...(input.ChecksumSHA256 ? { checksumSha256: sha } : {}),
        });
        return { ...ok(), ETag: etag };
      }
      case "HeadObject": {
        const obj = this.objects.get(key);
        if (!obj) throw s3Error(404, "NotFound", "UnknownError");
        return {
          ...ok(),
          ContentLength: obj.body.length,
          ContentType: obj.contentType ?? "binary/octet-stream",
          Metadata: obj.metadata ?? {},
          ETag: obj.etag,
          LastModified: new Date(),
          ...(input.ChecksumMode === "ENABLED" && obj.checksumSha256
            ? { ChecksumSHA256: obj.checksumSha256 }
            : {}),
        };
      }
      case "GetObject": {
        const obj = this.objects.get(key);
        if (!obj) throw s3Error(404, "NoSuchKey");
        if (input.IfMatch !== undefined && input.IfMatch !== obj.etag) {
          throw s3Error(412, "PreconditionFailed");
        }
        if (input.IfNoneMatch !== undefined && input.IfNoneMatch === obj.etag) {
          throw s3Error(304, "NotModified", "UnknownError");
        }
        const range = input.Range as string | undefined;
        if (range) {
          const size = obj.body.length;
          const m = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!m) throw s3Error(416, "InvalidRange");
          const start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
          const end = m[1] === "" || m[2] === "" ? size - 1 : Number(m[2]);
          const slice = obj.body.subarray(start, end + 1);
          return {
            ...ok(206),
            ContentLength: slice.length,
            ContentRange: `bytes ${start}-${end}/${size}`,
            ETag: obj.etag,
            Body: Readable.from([slice]),
          };
        }
        return {
          ...ok(),
          ContentLength: obj.body.length,
          ETag: obj.etag,
          Body: Readable.from([obj.body]),
        };
      }
      case "DeleteObject":
        this.objects.delete(key);
        return ok(204);
      case "ListObjectsV2": {
        const prefix = (input.Prefix as string | undefined) ?? "";
        const delimiter = input.Delimiter as string | undefined;
        const maxKeys = (input.MaxKeys as number | undefined) ?? 1000;
        const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
        const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const common = new Set<string>();
        const direct: string[] = [];
        for (const k of keys) {
          const rest = k.slice(prefix.length);
          const idx = delimiter ? rest.indexOf(delimiter) : -1;
          if (delimiter && idx >= 0) common.add(prefix + rest.slice(0, idx + 1));
          else direct.push(k);
        }
        const page = direct.slice(start, start + maxKeys);
        const truncated = start + maxKeys < direct.length;
        return {
          ...ok(),
          Prefix: prefix,
          KeyCount: page.length,
          Contents: page.map((k) => ({ Key: k, Size: this.objects.get(k)?.body.length })),
          CommonPrefixes: [...common].map((p) => ({ Prefix: p })),
          IsTruncated: truncated,
          ...(truncated ? { NextContinuationToken: String(start + maxKeys) } : {}),
        };
      }
      case "ListMultipartUploads":
        return {
          ...ok(),
          Uploads: [...this.uploads.entries()]
            .filter(([, u]) => u.key.startsWith((input.Prefix as string) ?? ""))
            .map(([id, u]) => ({ Key: u.key, UploadId: id })),
        };
      case "CreateMultipartUpload": {
        const id = `upload-${++this.uploadSeq}`;
        this.uploads.set(id, { key, parts: new Map() });
        return { ...ok(), UploadId: id };
      }
      case "UploadPart": {
        const upload = this.uploads.get(input.UploadId as string);
        if (!upload) throw s3Error(404, "NoSuchUpload");
        const body = Buffer.from(input.Body as Uint8Array);
        upload.parts.set(input.PartNumber as number, body);
        return { ...ok(), ETag: `"${createHash("md5").update(body).digest("hex")}"` };
      }
      case "CompleteMultipartUpload": {
        const id = input.UploadId as string;
        const upload = this.uploads.get(id);
        if (!upload) throw s3Error(404, "NoSuchUpload");
        const parts = [...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
        const body = Buffer.concat(parts);
        this.uploads.delete(id);
        const etag = `"${createHash("md5").update(body).digest("hex")}-${parts.length}"`;
        this.objects.set(key, { body, etag });
        return { ...ok(), ETag: etag };
      }
      case "AbortMultipartUpload":
        if (!this.uploads.delete(input.UploadId as string)) throw s3Error(404, "NoSuchUpload");
        return ok(204);
      default:
        throw new Error(`FakeS3: unsupported operation ${op}`);
    }
  }
}
