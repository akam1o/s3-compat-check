import { Command, InvalidArgumentError, Option } from "commander";
import { DEFAULTS } from "../core/config.js";
import type { RunOptions } from "../core/runner.js";
import { TOOL_NAME, TOOL_VERSION } from "../core/version.js";

export type OutputFormat = "text" | "json";

export interface CliOptions {
  run: Omit<RunOptions, "bucket"> & { bucket?: string };
  format: OutputFormat;
  output?: string;
  verbose: boolean;
  color: boolean;
  listChecks: boolean;
}

export interface OutputSink {
  write(text: string): unknown;
}

function parseInteger(value: string): number {
  if (!/^\d+$/.test(value.trim())) throw new InvalidArgumentError("Expected a positive integer.");
  return Number.parseInt(value, 10);
}

function parseList(value: string, previous: string[] | undefined): string[] {
  const items = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return [...(previous ?? []), ...items];
}

interface RawOptions {
  endpoint?: string;
  bucket?: string;
  region?: string;
  prefix: string;
  timeout: number;
  cleanupTimeout: number;
  concurrency: number;
  format: OutputFormat;
  output?: string;
  checks?: string[];
  skip?: string[];
  listChecks?: boolean;
  verbose?: boolean;
  color: boolean;
  pathStyle?: boolean;
  virtualHostedStyle?: boolean;
  allowInsecure?: boolean;
}

export function createProgram(stdout: OutputSink, stderr: OutputSink): Command {
  return new Command()
    .name(TOOL_NAME)
    .description(
      "S3 compatibility smoke tests in seconds.\n\n" +
        "Credentials are read from the AWS SDK default provider chain\n" +
        "(AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, AWS_PROFILE, IAM roles, ...).",
    )
    .version(TOOL_VERSION, "--version", "print the version and exit")
    .helpOption("-h, --help", "show help")
    .option(
      "--endpoint <url>",
      "S3 endpoint URL (default: AWS_ENDPOINT_URL_S3, AWS_ENDPOINT_URL, or AWS S3)",
    )
    .option("--bucket <name>", "existing bucket to run the checks in (required)")
    .option("--region <region>", `signing region (default: AWS_REGION or ${DEFAULTS.region})`)
    .option(
      "--prefix <prefix>",
      "base key prefix; a unique per-run prefix is created below it",
      DEFAULTS.prefix,
    )
    .option("--timeout <ms>", "timeout for each S3 operation", parseInteger, DEFAULTS.timeoutMs)
    .option(
      "--cleanup-timeout <ms>",
      "overall time budget for the final cleanup",
      parseInteger,
      DEFAULTS.cleanupTimeoutMs,
    )
    .option(
      "--concurrency <number>",
      "number of checks to run in parallel",
      parseInteger,
      DEFAULTS.concurrency,
    )
    .addOption(
      new Option("--format <format>", "report format").choices(["text", "json"]).default("text"),
    )
    .option("--output <file>", "also write the report (in --format) to a file")
    .option("--checks <names>", "comma-separated list of checks to run (default: all)", parseList)
    .option("--skip <names>", "comma-separated list of checks to skip", parseList)
    .option("--list-checks", "list available checks and exit")
    .option("--verbose", "print per-operation diagnostics to stderr")
    .option("--no-color", "disable colored output")
    .addOption(
      new Option(
        "--path-style",
        "force path-style addressing (default for custom endpoints)",
      ).conflicts("virtualHostedStyle"),
    )
    .option("--virtual-hosted-style", "force virtual-hosted-style addressing (default for AWS S3)")
    .option(
      "--allow-insecure",
      "allow plain HTTP endpoints (always allowed for localhost / 127.0.0.1 / ::1)",
    )
    .addHelpText(
      "after",
      `
Exit codes:
  0  all checks passed (unsupported optional features do not fail the run)
  1  at least one check failed, or cleanup failed
  2  invalid arguments or configuration
  3  fatal environment error (cannot connect, no credentials, bucket inaccessible)

Example:
  AWS_ACCESS_KEY_ID=ACCESS_KEY_EXAMPLE AWS_SECRET_ACCESS_KEY=SECRET_KEY_EXAMPLE \\
    ${TOOL_NAME} --endpoint http://localhost:9000 --bucket test-bucket`,
    )
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => stdout.write(s),
      writeErr: (s) => stderr.write(s),
    });
}

/** Parse argv (without the node/script entries). Throws `CommanderError`. */
export function parseCliOptions(
  argv: readonly string[],
  stdout: OutputSink,
  stderr: OutputSink,
): CliOptions {
  const program = createProgram(stdout, stderr);
  program.parse([...argv], { from: "user" });
  const o = program.opts<RawOptions>();

  const addressingStyle = o.pathStyle
    ? "path"
    : o.virtualHostedStyle
      ? "virtual-hosted"
      : undefined;

  return {
    run: {
      ...(o.endpoint !== undefined ? { endpoint: o.endpoint } : {}),
      ...(o.bucket !== undefined ? { bucket: o.bucket } : {}),
      ...(o.region !== undefined ? { region: o.region } : {}),
      prefix: o.prefix,
      timeoutMs: o.timeout,
      cleanupTimeoutMs: o.cleanupTimeout,
      concurrency: o.concurrency,
      ...(o.checks ? { checks: o.checks } : {}),
      ...(o.skip ? { skip: o.skip } : {}),
      ...(addressingStyle ? { addressingStyle } : {}),
      allowInsecure: o.allowInsecure ?? false,
    },
    format: o.format,
    ...(o.output !== undefined ? { output: o.output } : {}),
    verbose: o.verbose ?? false,
    color: o.color,
    listChecks: o.listChecks ?? false,
  };
}
