import { describe, expect, test } from "bun:test";
import { formatElapsed } from "../src/elapsed.js";

describe("formatElapsed", () => {
  test("zero elapsed", () => {
    expect(formatElapsed(0)).toBe("0:00");
  });

  test("under a minute", () => {
    expect(formatElapsed(5_000)).toBe("0:05");
  });

  test("several minutes", () => {
    expect(formatElapsed(7 * 60_000 + 5_000)).toBe("7:05");
  });

  test("exactly one hour boundary", () => {
    expect(formatElapsed(60 * 60_000)).toBe("1:00:00");
    // Just under an hour still uses m:ss.
    expect(formatElapsed(60 * 60_000 - 1_000)).toBe("59:59");
  });

  test("several hours", () => {
    expect(formatElapsed(1 * 60 * 60_000 + 2 * 60_000 + 3_000)).toBe("1:02:03");
    expect(formatElapsed(3 * 60 * 60_000 + 45 * 60_000 + 9_000)).toBe("3:45:09");
  });

  test("negative or garbage input clamps to zero", () => {
    expect(formatElapsed(-1_000)).toBe("0:00");
    expect(formatElapsed(NaN)).toBe("0:00");
    expect(formatElapsed(Infinity)).toBe("0:00");
    expect(formatElapsed(-Infinity)).toBe("0:00");
  });
});
