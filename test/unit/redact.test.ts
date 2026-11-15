import { describe, expect, it } from "vitest";
import { Redactor, createRedactor } from "../../src/core/redact.js";

describe("Redactor", () => {
  it("removes registered secret values", () => {
    const r = new Redactor(["SECRET_KEY_EXAMPLE_VALUE"]);
    expect(r.redact("key=SECRET_KEY_EXAMPLE_VALUE!")).toBe("key=[REDACTED]!");
  });

  it("ignores values that are too short to redact safely", () => {
    const r = new Redactor(["abc"]);
    expect(r.redact("abcdef")).toBe("abcdef");
  });

  it("reads secrets from the environment", () => {
    const r = createRedactor({
      AWS_SECRET_ACCESS_KEY: "SECRET_KEY_EXAMPLE_VALUE",
      AWS_SESSION_TOKEN: "SESSION_TOKEN_EXAMPLE_VALUE",
      AWS_REGION: "us-east-1",
    });
    expect(r.redact("SECRET_KEY_EXAMPLE_VALUE SESSION_TOKEN_EXAMPLE_VALUE us-east-1")).toBe(
      "[REDACTED] [REDACTED] us-east-1",
    );
  });

  it("strips presigned URL query strings", () => {
    const url =
      "https://storage.example.com/test-bucket/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ACCESS%2F20260101%2Fus-east-1&X-Amz-Signature=abcdef0123456789";
    const out = new Redactor().redact(`failed to GET ${url} (403)`);
    expect(out).toBe("failed to GET https://storage.example.com/test-bucket/key?[REDACTED] (403)");
  });

  it("redacts signing parameters without a URL", () => {
    const out = new Redactor().redact(
      "X-Amz-Signature=deadbeefcafe&X-Amz-Security-Token=tok123456",
    );
    expect(out).not.toContain("deadbeefcafe");
    expect(out).not.toContain("tok123456");
  });

  it("redacts Authorization headers", () => {
    const r = new Redactor();
    expect(
      r.redact("Authorization: AWS4-HMAC-SHA256 Credential=ACCESS/x, Signature=abcdef0123456789"),
    ).toBe("Authorization: [REDACTED]");
    expect(r.redact('{"authorization":"Bearer abc.def"}')).toBe('{"authorization":"[REDACTED]"}');
  });

  it("redacts userinfo in URLs and AWS-shaped access key ids", () => {
    const r = new Redactor();
    expect(r.redact("https://user:pass@storage.example.com")).toBe(
      "https://[REDACTED]@storage.example.com",
    );
    expect(r.redact("key AKIAIOSFODNN7EXAMPLE used")).toBe("key [REDACTED] used");
  });

  it("redacts nested structures without mutating them", () => {
    const r = new Redactor(["SECRET_KEY_EXAMPLE_VALUE"]);
    const input = { a: ["SECRET_KEY_EXAMPLE_VALUE"], b: { c: "ok", n: 1, z: null } };
    expect(r.redactDeep(input)).toEqual({ a: ["[REDACTED]"], b: { c: "ok", n: 1, z: null } });
    expect(input.a[0]).toBe("SECRET_KEY_EXAMPLE_VALUE");
  });
});
