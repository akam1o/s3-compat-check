import { access, constants, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ConfigError } from "../core/errors.js";
import type { RunReport } from "../core/result.js";
import { formatJson } from "../reporters/json.js";
import { formatText } from "../reporters/text.js";
import type { OutputFormat } from "./options.js";

export interface Stream {
  write(text: string): unknown;
  isTTY?: boolean;
}

export function useColor(stream: Stream, flag: boolean, env: NodeJS.ProcessEnv): boolean {
  if (!flag) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return stream.isTTY === true && env.TERM !== "dumb";
}

export function renderReport(
  report: RunReport,
  format: OutputFormat,
  options: { color: boolean; verbose: boolean },
): string {
  return format === "json" ? formatJson(report) : formatText(report, options);
}

/** Fail fast (before touching the bucket) if the report cannot be written. */
export async function assertWritableOutput(path: string): Promise<void> {
  const dir = dirname(resolve(path));
  try {
    await access(dir, constants.W_OK);
  } catch {
    throw new ConfigError(
      `Cannot write --output file: directory is not writable or does not exist`,
    );
  }
}

export async function writeReportFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: 0o644 });
}
