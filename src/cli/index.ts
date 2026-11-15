import { CommanderError } from "commander";
import { CHECK_IDS } from "../checks/index.js";
import { ConfigError, EnvironmentError, RunAbortedError } from "../core/errors.js";
import { createRedactor } from "../core/redact.js";
import { listChecks, runChecks } from "../core/runner.js";
import { fatalReport, formatFatalJson } from "../reporters/json.js";
import { formatCheckList } from "../reporters/text.js";
import { parseCliOptions, type CliOptions } from "./options.js";
import {
  assertWritableOutput,
  renderReport,
  useColor,
  writeReportFile,
  type Stream,
} from "./output.js";

export const EXIT = {
  OK: 0,
  CHECK_FAILED: 1,
  CONFIG_ERROR: 2,
  ENVIRONMENT_ERROR: 3,
  INTERRUPTED: 130,
} as const;

export interface CliIo {
  stdout: Stream;
  stderr: Stream;
  env: NodeJS.ProcessEnv;
}

/** Best-effort detection of `--format json` when argument parsing itself failed. */
function wantsJson(argv: readonly string[]): boolean {
  return argv.some(
    (arg, i) => arg === "--format=json" || (arg === "--format" && argv[i + 1] === "json"),
  );
}

function processIo(): CliIo {
  return { stdout: process.stdout, stderr: process.stderr, env: process.env };
}

async function reportFatal(
  io: CliIo,
  options: CliOptions | undefined,
  type: "config" | "environment" | "interrupted",
  message: string,
  detail?: EnvironmentError["detail"],
): Promise<void> {
  const redactor = createRedactor(io.env);
  const safeMessage = redactor.redact(message);
  if (options?.format === "json") {
    const json = formatFatalJson(redactor.redactDeep(fatalReport(type, safeMessage, detail)));
    io.stdout.write(json);
    if (options.output) {
      await writeReportFile(options.output, json).catch(() => undefined);
    }
  }
  io.stderr.write(`Error: ${safeMessage}\n`);
}

/**
 * CLI entry point. Returns the process exit code; never calls process.exit.
 * `argv` excludes the node binary and script path.
 */
export async function main(
  argv: readonly string[],
  io: CliIo = processIo(),
  signal?: AbortSignal,
): Promise<number> {
  const redactor = createRedactor(io.env);
  // Commander echoes argument values in its diagnostics; never print them raw.
  const safe = (stream: Stream): Stream => ({
    write: (text: string) => stream.write(redactor.redact(text)),
  });

  let options: CliOptions;
  try {
    options = parseCliOptions(argv, io.stdout, safe(io.stderr));
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version output are successful exits.
      if (error.exitCode === 0) return EXIT.OK;
      if (wantsJson(argv)) {
        io.stdout.write(
          formatFatalJson(
            fatalReport("config", redactor.redact(error.message.replace(/^error:\s*/i, ""))),
          ),
        );
      }
      return EXIT.CONFIG_ERROR;
    }
    throw error;
  }

  if (options.listChecks) {
    io.stdout.write(formatCheckList(listChecks()));
    return EXIT.OK;
  }

  const verbose = options.verbose
    ? (message: string) => io.stderr.write(`${redactor.redact(message)}\n`)
    : undefined;

  try {
    if (!options.run.bucket) throw new ConfigError("Missing required option --bucket");
    if (options.output) await assertWritableOutput(options.output);

    const report = await runChecks({
      ...options.run,
      bucket: options.run.bucket,
      env: io.env,
      ...(signal ? { signal } : {}),
      ...(verbose ? { logger: verbose } : {}),
    });

    const color = useColor(io.stdout, options.color, io.env);
    if (options.output) {
      // Keep a human-readable summary on stdout when the report goes to a file.
      io.stdout.write(renderReport(report, "text", { color, verbose: options.verbose }));
      try {
        await writeReportFile(
          options.output,
          renderReport(report, options.format, { color: false, verbose: options.verbose }),
        );
        io.stderr.write(`Report written to ${options.output}\n`);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        io.stderr.write(
          `Error: could not write the report to --output${typeof code === "string" ? ` (${code})` : ""}\n`,
        );
        return EXIT.ENVIRONMENT_ERROR;
      }
    } else {
      io.stdout.write(renderReport(report, options.format, { color, verbose: options.verbose }));
    }

    if (report.aborted) return EXIT.INTERRUPTED;
    return report.ok ? EXIT.OK : EXIT.CHECK_FAILED;
  } catch (error) {
    if (error instanceof RunAbortedError) {
      await reportFatal(io, options, "interrupted", "Interrupted before any check ran");
      return EXIT.INTERRUPTED;
    }
    if (error instanceof ConfigError) {
      await reportFatal(io, options, "config", error.message);
      if (error.message.startsWith("Unknown check")) {
        io.stderr.write(`Run with --list-checks to see available checks (${CHECK_IDS.length}).\n`);
      }
      return EXIT.CONFIG_ERROR;
    }
    if (error instanceof EnvironmentError) {
      await reportFatal(io, options, "environment", error.message, error.detail);
      return EXIT.ENVIRONMENT_ERROR;
    }
    // Unexpected failure: print only the (redacted) message, never the stack.
    const message = error instanceof Error ? error.message : String(error);
    await reportFatal(io, options, "environment", `Unexpected error: ${message}`);
    return EXIT.ENVIRONMENT_ERROR;
  }
}
