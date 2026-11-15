import type { CheckError } from "../core/errors.js";
import type { CheckResult, RunReport } from "../core/result.js";

export interface TextReporterOptions {
  color?: boolean;
  verbose?: boolean;
}

type Style = (text: string) => string;

interface Palette {
  green: Style;
  red: Style;
  yellow: Style;
  dim: Style;
  bold: Style;
}

function palette(enabled: boolean): Palette {
  const wrap =
    (open: number, close: number): Style =>
    (text) =>
      enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    green: wrap(32, 39),
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22),
  };
}

const NAME_WIDTH = 24;

/** Short label for a failure, e.g. "403 SignatureDoesNotMatch". */
export function errorLabel(error: CheckError | undefined): string {
  if (!error) return "failed";
  switch (error.kind) {
    case "http":
      return [error.httpStatus, error.code].filter((v) => v !== undefined).join(" ");
    case "timeout":
      return "timeout";
    case "network":
      return `network error${error.code ? ` ${error.code}` : ""}`;
    case "assertion":
      return "assertion failed";
    case "aborted":
      return "aborted";
    case "credentials":
      return "credentials error";
    default:
      return error.code ?? "error";
  }
}

function describeFailure(error: CheckError): string[] {
  const lines: string[] = [];
  const where = error.operation ? `${error.operation}: ` : "";
  const http =
    error.kind === "http" && error.httpStatus !== undefined
      ? ` (HTTP ${error.httpStatus}${error.code ? ` ${error.code}` : ""})`
      : "";
  lines.push(`${where}${error.message}${http}`);
  if (error.expected !== undefined || error.actual !== undefined) {
    lines.push(`expected: ${error.expected ?? "(n/a)"}`);
    lines.push(`actual:   ${error.actual ?? "(n/a)"}`);
  }
  if (error.requestId) lines.push(`request id: ${error.requestId}`);
  return lines;
}

function checkLine(result: CheckResult, p: Palette): string {
  const name = result.name.padEnd(NAME_WIDTH);
  switch (result.status) {
    case "passed":
      return `${p.green("✓")} ${name}${`${result.durationMs}`.padStart(6)} ms`;
    case "failed":
      return `${p.red("✗")} ${name}${p.red(errorLabel(result.error))}`;
    case "unsupported":
      return `${p.yellow("-")} ${name}${p.yellow("unsupported")}`;
    case "skipped":
      return `${p.dim("-")} ${name}${p.dim("skipped")}`;
  }
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatText(report: RunReport, options: TextReporterOptions = {}): string {
  const p = palette(options.color ?? false);
  const out: string[] = [];
  out.push(p.bold("S3 Compatibility Check"), "");
  out.push(`Endpoint: ${report.endpoint ?? "(AWS S3 default)"}`);
  out.push(`Bucket:   ${report.bucket}`);
  out.push(`Region:   ${report.region}`);
  if (options.verbose) {
    out.push(`Prefix:   ${report.runPrefix}`);
    out.push(`Style:    ${report.addressingStyle}`);
    out.push(
      p.dim(
        `Tool ${report.toolVersion}, AWS SDK ${report.environment.awsSdkVersion}, Node.js ${report.environment.node}`,
      ),
    );
  }
  out.push("");

  for (const r of report.checks) out.push(checkLine(r, p));

  const failed = report.checks.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    out.push("", p.bold("Failures:"));
    for (const r of failed) {
      out.push(`  ${p.red("✗")} ${r.name} ${p.dim(`(${r.id})`)}`);
      if (r.error) for (const line of describeFailure(r.error)) out.push(`      ${line}`);
    }
  }

  const unsupported = report.checks.filter((r) => r.status === "unsupported");
  if (unsupported.length > 0) {
    out.push("", p.bold("Unsupported (optional features):"));
    for (const r of unsupported) {
      out.push(`  ${p.yellow("-")} ${r.name}: ${r.error?.message ?? "not supported"}`);
    }
  }

  const skipped = report.checks.filter((r) => r.status === "skipped");
  if (skipped.length > 0 && options.verbose) {
    out.push("", p.bold("Skipped:"));
    for (const r of skipped) out.push(`  - ${r.name}: ${r.error?.message ?? "skipped"}`);
  }

  if (options.verbose) {
    const withDetails = report.checks.filter((r) => r.details && r.details.length > 0);
    if (withDetails.length > 0) {
      out.push("", p.bold("Details:"));
      for (const r of withDetails) {
        out.push(`  ${r.name}`);
        for (const d of r.details ?? []) out.push(`    - ${d}`);
      }
    }
  }

  const s = report.summary;
  const parts = [p.green(`${s.passed} passed`)];
  if (s.failed > 0) parts.push(p.red(`${s.failed} failed`));
  if (s.unsupported > 0) parts.push(p.yellow(`${s.unsupported} unsupported`));
  if (s.skipped > 0) parts.push(p.dim(`${s.skipped} skipped`));
  out.push("", parts.join(", "));

  const c = report.cleanup;
  const counts = `${c.deletedObjects} object(s) deleted, ${c.abortedUploads} upload(s) aborted`;
  if (c.status === "failed") {
    out.push(p.red(`Cleanup FAILED (${counts})`));
    for (const key of c.remaining) out.push(p.red(`  remaining: ${key}`));
    for (const e of c.errors) {
      const status =
        e.httpStatus !== undefined ? ` (HTTP ${e.httpStatus}${e.code ? ` ${e.code}` : ""})` : "";
      out.push(p.red(`  ${e.operation}${e.key ? ` ${e.key}` : ""}: ${e.message}${status}`));
    }
  } else if (options.verbose) {
    out.push(p.dim(`Cleanup: ${c.status} (${counts})`));
  }
  if (options.verbose) for (const w of c.warnings) out.push(p.yellow(`Warning: ${w}`));
  if (report.aborted) out.push(p.yellow("Run was interrupted."));

  out.push(`Duration: ${formatSeconds(report.durationMs)}`);
  return `${out.join("\n")}\n`;
}

export function formatCheckList(
  checks: ReadonlyArray<{ id: string; name: string; description: string; required: boolean }>,
): string {
  const idWidth = Math.max(...checks.map((c) => c.id.length)) + 2;
  const lines = checks.map(
    (c) => `${c.id.padEnd(idWidth)}${c.description}${c.required ? "" : " (optional)"}`,
  );
  return `${lines.join("\n")}\n`;
}
