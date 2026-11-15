import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChecks } from "../../src/core/runner.js";

/**
 * A tiny local HTTP server that speaks just enough S3 for the "get" check and
 * then stalls in the middle of the GetObject body. Uses the real AWS SDK.
 */
let server: Server;
let endpoint: string;
const stored = new Set<string>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    req.resume();
    const xml = (body: string) => {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
    };
    if (req.method === "HEAD" && /^\/test-bucket\/?$/.test(url.pathname)) {
      return res.writeHead(200).end();
    }
    if (req.method === "GET" && url.searchParams.has("list-type")) {
      return xml(
        "<ListBucketResult><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>",
      );
    }
    if (req.method === "GET" && url.searchParams.has("versions")) {
      return xml("<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>");
    }
    if (req.method === "GET" && url.searchParams.has("uploads")) {
      return xml(
        "<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>",
      );
    }
    if (req.method === "PUT") {
      stored.add(url.pathname);
      return res.writeHead(200, { etag: '"0123"' }).end();
    }
    if (req.method === "DELETE") {
      stored.delete(url.pathname);
      return res.writeHead(204).end();
    }
    if (req.method === "GET") {
      // Valid headers and one byte, then nothing.
      res.writeHead(200, { "content-length": "1024", etag: '"0123"' });
      res.write(Buffer.alloc(1));
      return;
    }
    res.writeHead(400).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("body streaming timeout with the real SDK", () => {
  it("reports a stalled body as a timeout, not a connection reset", async () => {
    const started = Date.now();
    const report = await runChecks({
      endpoint,
      bucket: "test-bucket",
      checks: ["get"],
      timeoutMs: 300,
      credentials: { accessKeyId: "ACCESS_KEY_EXAMPLE", secretAccessKey: "SECRET_KEY_EXAMPLE" },
      env: {},
    });
    expect(report.checks[0]?.error).toMatchObject({ kind: "timeout", operation: "GetObject" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(stored.size).toBe(0);
  });
});
