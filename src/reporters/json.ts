import type { CheckError } from "../core/errors.js";
import type { RunReport } from "../core/result.js";
import { TOOL_NAME, TOOL_VERSION } from "../core/version.js";

export function formatJson(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export interface FatalReport {
  schemaVersion: "1.0";
  tool: typeof TOOL_NAME;
  toolVersion: string;
  ok: false;
  error: {
    /** "config" maps to exit code 2, "environment" to exit code 3. */
    type: "config" | "environment";
    message: string;
    detail?: CheckError;
  };
}

export function fatalReport(
  type: "config" | "environment",
  message: string,
  detail?: CheckError,
): FatalReport {
  return {
    schemaVersion: "1.0",
    tool: TOOL_NAME,
    toolVersion: TOOL_VERSION,
    ok: false,
    error: { type, message, ...(detail ? { detail } : {}) },
  };
}

export function formatFatalJson(report: FatalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
