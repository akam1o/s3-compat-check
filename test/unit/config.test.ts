import { describe, expect, it } from "vitest";
import {
  RUN_ID_PATTERN,
  generateRunId,
  isOwnedKey,
  normalizePrefix,
  resolveConfig,
  selectChecks,
  validateEndpoint,
} from "../../src/core/config.js";
import { ConfigError } from "../../src/core/errors.js";

const IDS = ["put", "get", "head", "checksum"];

describe("validateEndpoint", () => {
  it("accepts https endpoints and strips trailing slashes", () => {
    expect(validateEndpoint("https://storage.example.com/", false)).toBe(
      "https://storage.example.com",
    );
  });

  it("allows plain HTTP on loopback hosts only", () => {
    expect(validateEndpoint("http://localhost:9000", false)).toBe("http://localhost:9000");
    expect(validateEndpoint("http://127.0.0.1:9000", false)).toBe("http://127.0.0.1:9000");
    expect(validateEndpoint("http://[::1]:9000", false)).toBe("http://[::1]:9000");
    expect(() => validateEndpoint("http://storage.example.com", false)).toThrow(/--allow-insecure/);
    expect(validateEndpoint("http://storage.example.com", true)).toBe("http://storage.example.com");
  });

  it("rejects credentials, queries and unsupported protocols", () => {
    expect(() => validateEndpoint("https://user:pass@storage.example.com", false)).toThrow(
      ConfigError,
    );
    expect(() => validateEndpoint("https://storage.example.com/?a=b", false)).toThrow(ConfigError);
    expect(() => validateEndpoint("ftp://storage.example.com", false)).toThrow(ConfigError);
    expect(() => validateEndpoint("not a url", false)).toThrow(ConfigError);
  });

  it("does not echo embedded credentials in the error", () => {
    try {
      validateEndpoint("https://ACCESS_KEY_EXAMPLE:SECRET_KEY_EXAMPLE@storage.example.com", false);
    } catch (e) {
      expect(String(e)).not.toContain("SECRET_KEY_EXAMPLE");
    }
  });
});

describe("normalizePrefix", () => {
  it("adds a trailing slash", () => {
    expect(normalizePrefix("a/b")).toBe("a/b/");
    expect(normalizePrefix("a/b/")).toBe("a/b/");
    expect(normalizePrefix("")).toBe("");
  });

  it("rejects unsafe prefixes", () => {
    expect(() => normalizePrefix("/abs")).toThrow(ConfigError);
    expect(() => normalizePrefix("a/../b")).toThrow(ConfigError);
    expect(() => normalizePrefix("a\nb")).toThrow(ConfigError);
  });
});

describe("selectChecks", () => {
  it("selects all checks by default, in registry order", () => {
    expect(selectChecks(IDS, undefined, undefined)).toEqual(IDS);
    expect(selectChecks(IDS, ["all"], undefined)).toEqual(IDS);
  });

  it("keeps registry order regardless of the given order", () => {
    expect(selectChecks(IDS, ["head", "put"], undefined)).toEqual(["put", "head"]);
  });

  it("applies --skip after --checks", () => {
    expect(selectChecks(IDS, undefined, ["get"])).toEqual(["put", "head", "checksum"]);
    expect(selectChecks(IDS, ["put", "get"], ["get"])).toEqual(["put"]);
  });

  it("rejects unknown and empty selections", () => {
    expect(() => selectChecks(IDS, ["nope"], undefined)).toThrow(/Unknown check\(s\): nope/);
    expect(() => selectChecks(IDS, undefined, ["nope"])).toThrow(ConfigError);
    expect(() => selectChecks(IDS, ["put"], ["put"])).toThrow(/No checks selected/);
  });
});

describe("resolveConfig", () => {
  const now = new Date("2026-01-02T03:04:05.678Z");

  it("applies defaults", () => {
    const c = resolveConfig({ bucket: "test-bucket" }, IDS, {}, now);
    expect(c).toMatchObject({
      bucket: "test-bucket",
      region: "us-east-1",
      basePrefix: "s3-compat-check/",
      timeoutMs: 10_000,
      concurrency: 4,
      addressingStyle: "virtual-hosted",
      checkIds: IDS,
    });
    expect(c.endpoint).toBeUndefined();
    expect(c.runPrefix).toMatch(/^s3-compat-check\/20260102T030405Z-[0-9a-f]{8}\/$/);
  });

  it("defaults to path-style for custom endpoints", () => {
    const c = resolveConfig({ bucket: "b1", endpoint: "http://localhost:9000" }, IDS, {}, now);
    expect(c.addressingStyle).toBe("path");
    const v = resolveConfig(
      { bucket: "b1", endpoint: "http://localhost:9000", addressingStyle: "virtual-hosted" },
      IDS,
      {},
      now,
    );
    expect(v.addressingStyle).toBe("virtual-hosted");
  });

  it("reads region and endpoint from the environment", () => {
    const c = resolveConfig(
      { bucket: "b1" },
      IDS,
      { AWS_REGION: "eu-west-1", AWS_ENDPOINT_URL_S3: "https://storage.example.com" },
      now,
    );
    expect(c.region).toBe("eu-west-1");
    expect(c.endpoint).toBe("https://storage.example.com");
    // The HTTP safety rule also applies to endpoints from the environment.
    expect(() =>
      resolveConfig({ bucket: "b1" }, IDS, { AWS_ENDPOINT_URL: "http://storage.example.com" }, now),
    ).toThrow(/--allow-insecure/);
  });

  it("prefers explicit options over the environment", () => {
    const c = resolveConfig(
      { bucket: "b1", region: "auto" },
      IDS,
      { AWS_REGION: "eu-west-1" },
      now,
    );
    expect(c.region).toBe("auto");
  });

  it("validates numeric options and the bucket", () => {
    expect(() => resolveConfig({ bucket: "b1", timeoutMs: 0 }, IDS, {}, now)).toThrow(/--timeout/);
    expect(() => resolveConfig({ bucket: "b1", concurrency: 0 }, IDS, {}, now)).toThrow(
      /--concurrency/,
    );
    expect(() => resolveConfig({ bucket: "b1", concurrency: 1.5 }, IDS, {}, now)).toThrow(
      /--concurrency/,
    );
    expect(() => resolveConfig({}, IDS, {}, now)).toThrow(/--bucket/);
    expect(() => resolveConfig({ bucket: "a/b" }, IDS, {}, now)).toThrow(/--bucket/);
  });
});

describe("run prefix ownership", () => {
  it("generates ids matching the guard pattern", () => {
    expect(generateRunId()).toMatch(RUN_ID_PATTERN);
  });

  it("only accepts keys strictly below a well-formed run prefix", () => {
    const prefix = "s3-compat-check/20260102T030405Z-0123abcd/";
    expect(isOwnedKey(`${prefix}put/object.bin`, prefix)).toBe(true);
    expect(isOwnedKey(prefix, prefix)).toBe(false);
    expect(isOwnedKey("s3-compat-check/other", prefix)).toBe(false);
    expect(isOwnedKey("important/data", prefix)).toBe(false);
    // A malformed run prefix never owns anything.
    expect(isOwnedKey("s3-compat-check/x", "s3-compat-check/")).toBe(false);
    expect(isOwnedKey("anything", "")).toBe(false);
  });
});
