import { describe, expect, it, vi } from "vitest";
import { main, type CliIo } from "../../src/cli/index.js";
import { parseCliOptions } from "../../src/cli/options.js";
import { useColor } from "../../src/cli/output.js";

function capture(env: NodeJS.ProcessEnv = {}): CliIo & { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    env,
    out: () => out,
    err: () => err,
  };
}

const sink = { write: () => true };

describe("parseCliOptions", () => {
  it("applies defaults", () => {
    const o = parseCliOptions(["--bucket", "test-bucket"], sink, sink);
    expect(o).toEqual({
      run: {
        bucket: "test-bucket",
        prefix: "s3-compat-check/",
        timeoutMs: 10_000,
        cleanupTimeoutMs: 30_000,
        concurrency: 4,
        allowInsecure: false,
      },
      format: "text",
      verbose: false,
      color: true,
      listChecks: false,
    });
  });

  it("parses all options", () => {
    const o = parseCliOptions(
      [
        "--endpoint",
        "https://storage.example.com",
        "--bucket",
        "test-bucket",
        "--region",
        "auto",
        "--prefix",
        "ci/",
        "--timeout",
        "500",
        "--concurrency",
        "2",
        "--format",
        "json",
        "--output",
        "out.json",
        "--checks",
        "put, GET",
        "--checks",
        "head",
        "--skip",
        "range",
        "--verbose",
        "--no-color",
        "--path-style",
        "--allow-insecure",
      ],
      sink,
      sink,
    );
    expect(o.run).toMatchObject({
      endpoint: "https://storage.example.com",
      region: "auto",
      prefix: "ci/",
      timeoutMs: 500,
      concurrency: 2,
      checks: ["put", "get", "head"],
      skip: ["range"],
      addressingStyle: "path",
      allowInsecure: true,
    });
    expect(o).toMatchObject({ format: "json", output: "out.json", verbose: true, color: false });
  });

  it("supports --virtual-hosted-style", () => {
    const o = parseCliOptions(["--bucket", "b1", "--virtual-hosted-style"], sink, sink);
    expect(o.run.addressingStyle).toBe("virtual-hosted");
  });
});

describe("main", () => {
  it("prints help and version with exit code 0", async () => {
    const io = capture();
    expect(await main(["--help"], io)).toBe(0);
    expect(io.out()).toContain("--endpoint <url>");
    const io2 = capture();
    expect(await main(["--version"], io2)).toBe(0);
    expect(io2.out().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("lists checks without requiring a bucket", async () => {
    const io = capture();
    expect(await main(["--list-checks"], io)).toBe(0);
    expect(io.out()).toContain("multipart");
    expect(io.out()).toContain("(optional)");
  });

  it.each([
    [["--endpoint", "http://localhost:9000"]],
    [["--bucket", "b1", "--format", "xml"]],
    [["--bucket", "b1", "--timeout", "abc"]],
    [["--bucket", "b1", "--timeout", "0"]],
    [["--bucket", "b1", "--checks", "nope"]],
    [["--bucket", "b1", "--path-style", "--virtual-hosted-style"]],
    [["--bucket", "b1", "--endpoint", "http://storage.example.com"]],
    [["--bucket", "b1", "--unknown-flag"]],
    [["--bucket", "b1", "extra-argument"]],
    [["--bucket", "b1", "--output", "/nonexistent-dir-s3cc/out.json"]],
  ])("exits with 2 for invalid arguments: %j", async (argv) => {
    const io = capture();
    expect(await main(argv, io)).toBe(2);
    expect(io.err()).not.toBe("");
  });

  it("emits a machine-readable fatal report in JSON mode", async () => {
    const io = capture();
    const code = await main(
      ["--bucket", "b1", "--endpoint", "http://storage.example.com", "--format", "json"],
      io,
    );
    expect(code).toBe(2);
    const parsed = JSON.parse(io.out()) as { ok: boolean; error: { type: string } };
    expect(parsed).toMatchObject({ ok: false, error: { type: "config" } });
  });

  it("exits with 3 when the endpoint is unreachable, without leaking secrets", async () => {
    // The SDK credential chain reads process.env; never let it find real credentials.
    const env = {
      AWS_ACCESS_KEY_ID: "ACCESS_KEY_EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "SECRET_KEY_EXAMPLE_VALUE",
    };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.stubEnv("AWS_PROFILE", "");
    try {
      const io = capture(env);
      const code = await main(
        ["--endpoint", "http://127.0.0.1:9", "--bucket", "b1", "--timeout", "2000", "--verbose"],
        io,
      );
      expect(code).toBe(3);
      expect(io.err()).toMatch(/Cannot connect|Timed out/);
      expect(io.out() + io.err()).not.toContain("SECRET_KEY_EXAMPLE_VALUE");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("useColor", () => {
  it("honours flags, NO_COLOR and TTY detection", () => {
    expect(useColor({ write: () => 0, isTTY: true }, true, {})).toBe(true);
    expect(useColor({ write: () => 0, isTTY: true }, false, {})).toBe(false);
    expect(useColor({ write: () => 0, isTTY: true }, true, { NO_COLOR: "1" })).toBe(false);
    expect(useColor({ write: () => 0, isTTY: false }, true, {})).toBe(false);
    expect(useColor({ write: () => 0, isTTY: false }, true, { FORCE_COLOR: "1" })).toBe(true);
  });
});
