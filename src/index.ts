export { runChecks, listChecks, type RunOptions } from "./core/runner.js";
export type {
  CheckResult,
  CheckStatus,
  CleanupError,
  CleanupReport,
  RunReport,
  Summary,
} from "./core/result.js";
export {
  ConfigError,
  EnvironmentError,
  RunAbortedError,
  type CheckError,
  type ErrorKind,
} from "./core/errors.js";
export type { AddressingStyle } from "./core/config.js";
export { formatText } from "./reporters/text.js";
export { formatJson } from "./reporters/json.js";
