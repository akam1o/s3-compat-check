#!/usr/bin/env node
import { main } from "./cli/index.js";

const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };
/** Upper bound on how long we wait for cleanup after a signal. */
const FORCE_EXIT_AFTER_MS = 45_000;

const controller = new AbortController();
let received: NodeJS.Signals | undefined;

function onSignal(signal: NodeJS.Signals): void {
  const code = SIGNAL_EXIT_CODES[signal] ?? 1;
  if (received) {
    process.stderr.write(`\nReceived ${signal} again; exiting without waiting for cleanup.\n`);
    process.exit(code);
  }
  received = signal;
  process.stderr.write(
    `\nReceived ${signal}; cleaning up test objects (send again to force exit)...\n`,
  );
  controller.abort();
  setTimeout(() => {
    process.stderr.write("Cleanup did not finish in time; exiting.\n");
    process.exit(code);
  }, FORCE_EXIT_AFTER_MS).unref();
}

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

const code = await main(process.argv.slice(2), undefined, controller.signal);
process.exitCode = received && code !== 2 ? (SIGNAL_EXIT_CODES[received] ?? code) : code;
