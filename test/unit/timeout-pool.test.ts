import { describe, expect, it } from "vitest";
import { deterministicBytes, firstDifference, seedFrom } from "../../src/core/data.js";
import {
  DeadlineExceededError,
  OperationTimeoutError,
  RunAbortedError,
} from "../../src/core/errors.js";
import { mapWithConcurrency } from "../../src/core/pool.js";
import { withTimeout } from "../../src/core/timeout.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withTimeout", () => {
  it("returns the result when fast enough", async () => {
    await expect(withTimeout("Op", 1000, undefined, async () => 42)).resolves.toBe(42);
  });

  it("times out even if the function ignores the signal", async () => {
    const started = Date.now();
    await expect(withTimeout("Slow", 50, undefined, () => sleep(5_000))).rejects.toBeInstanceOf(
      OperationTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("passes an abortable signal to the function", async () => {
    let seen: AbortSignal | undefined;
    await expect(
      withTimeout("Op", 30, undefined, (signal) => {
        seen = signal;
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      }),
    ).rejects.toBeInstanceOf(OperationTimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  it("reports parent aborts as RunAbortedError", async () => {
    const controller = new AbortController();
    const p = withTimeout("Op", 5_000, controller.signal, () => sleep(5_000));
    controller.abort();
    await expect(p).rejects.toBeInstanceOf(RunAbortedError);
    await expect(withTimeout("Op", 5_000, controller.signal, async () => 1)).rejects.toBeInstanceOf(
      RunAbortedError,
    );
  });

  it("reports an expired deadline parent as DeadlineExceededError", async () => {
    const deadline = AbortSignal.timeout(20);
    await expect(withTimeout("Op", 5_000, deadline, () => sleep(5_000))).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
  });

  it("propagates ordinary errors", async () => {
    await expect(
      withTimeout("Op", 1000, undefined, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("mapWithConcurrency", () => {
  it("limits parallelism and preserves order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([30, 5, 20, 1, 10, 2], 2, async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(ms);
      active--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("handles empty input and concurrency larger than the input", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 10, async (x) => x * 2)).toEqual([2, 4]);
  });
});

describe("deterministicBytes", () => {
  it("is reproducible and seed-dependent", () => {
    expect(deterministicBytes(1027, "a").equals(deterministicBytes(1027, "a"))).toBe(true);
    expect(deterministicBytes(64, "a").equals(deterministicBytes(64, "b"))).toBe(false);
    expect(deterministicBytes(1027, "a")).toHaveLength(1027);
    expect(seedFrom("x")).toBeGreaterThan(0);
  });

  it("finds the first differing byte", () => {
    const a = Buffer.from([1, 2, 3]);
    expect(firstDifference(a, Buffer.from([1, 2, 3]))).toBe(-1);
    expect(firstDifference(a, Buffer.from([1, 9, 3]))).toBe(1);
    expect(firstDifference(a, Buffer.from([1, 2]))).toBe(2);
  });
});
