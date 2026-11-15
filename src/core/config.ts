import { randomBytes } from "node:crypto";
import { ConfigError } from "./errors.js";

export type AddressingStyle = "path" | "virtual-hosted";

export interface ConfigInput {
  endpoint?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  concurrency?: number;
  checks?: readonly string[];
  skip?: readonly string[];
  addressingStyle?: AddressingStyle;
  allowInsecure?: boolean;
}

export interface ResolvedConfig {
  endpoint?: string;
  bucket: string;
  region: string;
  basePrefix: string;
  runPrefix: string;
  timeoutMs: number;
  cleanupTimeoutMs: number;
  concurrency: number;
  checkIds: string[];
  addressingStyle: AddressingStyle;
}

export const DEFAULTS = {
  region: "us-east-1",
  prefix: "s3-compat-check/",
  timeoutMs: 10_000,
  cleanupTimeoutMs: 30_000,
  concurrency: 4,
} as const;

export const LIMITS = {
  timeoutMs: { min: 100, max: 600_000 },
  concurrency: { min: 1, max: 32 },
} as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Suffix appended to the base prefix; also used as a safety guard on deletes. */
export const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Validate and normalize the endpoint. Returns the URL without a trailing slash. */
export function validateEndpoint(raw: string, allowInsecure: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`Invalid --endpoint: expected an absolute http(s) URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`Invalid --endpoint: unsupported protocol "${url.protocol}"`);
  }
  if (url.username || url.password) {
    throw new ConfigError(
      "Invalid --endpoint: credentials must not be embedded in the URL; use the AWS credential chain",
    );
  }
  if (url.search || url.hash) {
    throw new ConfigError("Invalid --endpoint: query strings and fragments are not allowed");
  }
  if (url.protocol === "http:" && !allowInsecure && !isLoopbackHost(url.hostname)) {
    throw new ConfigError(
      `Refusing to use an unencrypted HTTP endpoint (${url.host}). Pass --allow-insecure to allow it.`,
    );
  }
  return url.toString().replace(/\/+$/, "");
}

export function validateBucket(bucket: string | undefined): string {
  if (!bucket) throw new ConfigError("Missing required option --bucket");
  // Deliberately looser than AWS rules: some implementations allow other names.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(bucket)) {
    throw new ConfigError(`Invalid --bucket "${bucket}"`);
  }
  return bucket;
}

export function normalizePrefix(prefix: string): string {
  if (prefix === "") return "";
  if (prefix.startsWith("/")) throw new ConfigError("Invalid --prefix: must not start with '/'");
  if (prefix.length > 512) throw new ConfigError("Invalid --prefix: too long");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(prefix)) {
    throw new ConfigError("Invalid --prefix: control characters are not allowed");
  }
  const segments = prefix.split("/");
  if (segments.some((s) => s === "." || s === "..")) {
    throw new ConfigError("Invalid --prefix: '.' and '..' segments are not allowed");
  }
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

export function generateRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

function intInRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`Invalid ${name}: expected an integer between ${min} and ${max}`);
  }
  return value;
}

/** Resolve the list of check ids to run from `--checks` / `--skip`. */
export function selectChecks(
  available: readonly string[],
  rawInclude: readonly string[] | undefined,
  rawExclude: readonly string[] | undefined,
): string[] {
  const normalize = (ids: readonly string[] | undefined) =>
    ids?.map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0);
  const include = normalize(rawInclude);
  const exclude = normalize(rawExclude);
  if (exclude?.includes("all")) {
    throw new ConfigError("--skip all would skip every check");
  }
  const known = new Set(available);
  const unknown = [...(include ?? []), ...(exclude ?? [])].filter(
    (id) => id !== "all" && !known.has(id),
  );
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown check(s): ${[...new Set(unknown)].join(", ")}. Available: ${available.join(", ")}`,
    );
  }
  const wanted =
    include && include.length > 0 && !include.includes("all") ? new Set(include) : known;
  const skipped = new Set(exclude ?? []);
  // Preserve registry order regardless of the order given on the command line.
  const selected = available.filter((id) => wanted.has(id) && !skipped.has(id));
  if (selected.length === 0) throw new ConfigError("No checks selected");
  return selected;
}

export function resolveConfig(
  input: ConfigInput,
  availableChecks: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): ResolvedConfig {
  const bucket = validateBucket(input.bucket);
  const rawEndpoint = input.endpoint ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;
  const endpoint = rawEndpoint
    ? validateEndpoint(rawEndpoint, input.allowInsecure ?? false)
    : undefined;
  const region = input.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? DEFAULTS.region;
  if (!/^[a-z0-9-]{1,64}$/i.test(region)) throw new ConfigError(`Invalid --region "${region}"`);

  const timeoutMs = intInRange(
    "--timeout",
    input.timeoutMs ?? DEFAULTS.timeoutMs,
    LIMITS.timeoutMs.min,
    LIMITS.timeoutMs.max,
  );
  const cleanupTimeoutMs = intInRange(
    "cleanup timeout",
    input.cleanupTimeoutMs ?? DEFAULTS.cleanupTimeoutMs,
    LIMITS.timeoutMs.min,
    LIMITS.timeoutMs.max,
  );
  const concurrency = intInRange(
    "--concurrency",
    input.concurrency ?? DEFAULTS.concurrency,
    LIMITS.concurrency.min,
    LIMITS.concurrency.max,
  );

  const basePrefix = normalizePrefix(input.prefix ?? DEFAULTS.prefix);
  const runPrefix = `${basePrefix}${generateRunId(now)}/`;

  // Custom endpoints rarely have wildcard DNS for bucket subdomains.
  const addressingStyle = input.addressingStyle ?? (endpoint ? "path" : "virtual-hosted");

  return {
    ...(endpoint ? { endpoint } : {}),
    bucket,
    region,
    basePrefix,
    runPrefix,
    timeoutMs,
    cleanupTimeoutMs,
    concurrency,
    checkIds: selectChecks(availableChecks, input.checks, input.skip),
    addressingStyle,
  };
}

/** True if `key` belongs to the namespace created by this run. */
export function isOwnedKey(key: string, runPrefix: string): boolean {
  const runId = runPrefix.slice(0, -1).split("/").pop() ?? "";
  return (
    runPrefix.endsWith("/") &&
    RUN_ID_PATTERN.test(runId) &&
    key.startsWith(runPrefix) &&
    key.length > runPrefix.length
  );
}
