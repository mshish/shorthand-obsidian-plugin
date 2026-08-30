import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STATE_TRANSITIONS } from "../src/state.js";

/**
 * The diagram in docs/capture-states.md is documentation of a state machine, which is
 * the kind of documentation that rots fastest and most invisibly: nothing fails when a
 * transition is added and the picture is not. So it is generated here and compared,
 * rather than trusted.
 */
describe("the capture state diagram", () => {
  test("matches the reducer's own transition table", () => {
    const doc = readFileSync(resolve(process.cwd(), "docs/capture-states.md"), "utf8");
    const expected = STATE_TRANSITIONS.map(({ from, event, to }) => `    ${from} --> ${to}: ${event}`);
    for (const line of expected) {
      expect(doc).toContain(line);
    }
  });

  test("draws no transition the reducer cannot make", () => {
    const doc = readFileSync(resolve(process.cwd(), "docs/capture-states.md"), "utf8");
    const drawn = [...doc.matchAll(/^ {4}(\S+) --> (\S+): (\S+)$/gm)].map((match) => `${match[1]}|${match[3]}|${match[2]}`);
    const real = new Set(STATE_TRANSITIONS.map(({ from, event, to }) => `${from}|${event}|${to}`));
    for (const edge of drawn) {
      expect(real.has(edge)).toBe(true);
    }
  });
});
