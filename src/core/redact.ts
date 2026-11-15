/**
 * Redaction of credentials and signatures from any text that leaves the
 * process (stdout, stderr, JSON reports, error messages).
 */

const REDACTED = "[REDACTED]";

/** Environment variables whose values must never be printed. */
export const SECRET_ENV_VARS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
] as const;

const PATTERNS: Array<[RegExp, string]> = [
  // Presigned URLs: drop the whole query string, it is the credential.
  [/(https?:\/\/[^\s"'<>?]*)\?[^\s"'<>]*X-Amz-[^\s"'<>]*/gi, `$1?${REDACTED}`],
  // Individual signing query parameters (in case they appear without a URL).
  [
    /\b(X-Amz-(?:Signature|Credential|Security-Token)|AWSAccessKeyId|Signature|x-amz-security-token)=[^&\s"'<>]+/gi,
    `$1=${REDACTED}`,
  ],
  // Authorization and signing headers, in "Header: value" and JSON-ish forms.
  [/(\bauthorization["']?\s*[:=]\s*["']?)[^"'\r\n}]+/gi, `$1${REDACTED}`],
  [
    /(\b(?:x-amz-(?:security-token|signature|credential)|signature)["']?\s*:\s*["']?)[^"'\s,}<]+/gi,
    `$1${REDACTED}`,
  ],
  [/(\bx-amz-security-token["']?\s*=\s*["']?)[^"'\r\n,}&]+/gi, `$1${REDACTED}`],
  // SigV4 fragments.
  [/\bAWS4-HMAC-SHA256\s+Credential=[^\s"']+/g, `AWS4-HMAC-SHA256 ${REDACTED}`],
  [/\b(Credential|Signature)=[A-Za-z0-9/+=_%-]{8,}/g, `$1=${REDACTED}`],
  // Userinfo embedded in URLs.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']*@/gi, `$1${REDACTED}@`],
  // Common shapes of AWS access key ids.
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
];

export class Redactor {
  private readonly secrets = new Set<string>();

  constructor(secrets: Iterable<string | undefined> = []) {
    for (const s of secrets) this.addSecret(s);
  }

  /** Register an exact value to scrub from all output. */
  addSecret(value: string | undefined): void {
    // Very short values would cause excessive false positives.
    if (typeof value === "string" && value.length >= 6) this.secrets.add(value);
  }

  redact(text: string): string {
    let out = text;
    // Longest first so that overlapping secrets are fully removed.
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join(REDACTED);
    }
    for (const [pattern, replacement] of PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    return out;
  }

  /** Redact every string in a JSON-compatible value. Returns a new value. */
  redactDeep<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.walk(v);
      return out;
    }
    return value;
  }
}

export function createRedactor(env: NodeJS.ProcessEnv = process.env): Redactor {
  return new Redactor(SECRET_ENV_VARS.map((name) => env[name]));
}
