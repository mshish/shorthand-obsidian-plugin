import { describe, expect, test } from "bun:test";
import type { LlmCredentials } from "shorthand-core";
import {
  LlmProfileCommitQueue,
  type LlmProfileCommitCallbacks,
} from "../src/llm-profile-commit-queue.js";
import type { LlmProfileDraft } from "../src/llm-profile-draft.js";

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}>;

function deferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function draft(overrides: Partial<LlmProfileDraft> = {}): LlmProfileDraft {
  return {
    provider: "openai",
    model: "initial-model",
    api_key: "initial-key",
    base_url: "https://example.test/v1",
    ...overrides,
  };
}

function controlledCallbacks(): Readonly<{
  callbacks: LlmProfileCommitCallbacks;
  attempts: LlmCredentials[];
  events: string[];
  lastCompleted(): LlmCredentials | undefined;
  maxActive(): number;
  waitUntilStarted(index: number): Promise<void>;
  resolve(index: number): void;
  reject(index: number, error: unknown): void;
}> {
  const attempts: LlmCredentials[] = [];
  const events: string[] = [];
  const gates: Deferred[] = [];
  const startedWaiters = new Map<number, Deferred>();
  let active = 0;
  let highestActive = 0;
  let completed: LlmCredentials | undefined;

  const attemptAt = (index: number): LlmCredentials => {
    const attempt = attempts[index];
    if (attempt === undefined) throw new Error(`Write ${index} has not started`);
    return attempt;
  };

  const gateAt = (index: number): Deferred => {
    const gate = gates[index];
    if (gate === undefined) throw new Error(`Write ${index} has not started`);
    return gate;
  };

  return {
    callbacks: {
      write: async (credentials) => {
        const index = attempts.length;
        attempts.push(credentials);
        const gate = deferred();
        gates.push(gate);
        active += 1;
        highestActive = Math.max(highestActive, active);
        events.push(`start:${credentials.model}`);
        startedWaiters.get(index)?.resolve();
        try {
          await gate.promise;
          completed = credentials;
          events.push(`finish:${credentials.model}`);
        } finally {
          active -= 1;
        }
      },
      onInvalid: () => {},
      onSaving: () => {},
      onSaved: () => {},
      onSaveFailed: () => {},
    },
    attempts,
    events,
    lastCompleted: () => completed,
    maxActive: () => highestActive,
    waitUntilStarted: async (index) => {
      if (attempts[index] !== undefined) return;
      const waiter = deferred();
      startedWaiters.set(index, waiter);
      await waiter.promise;
    },
    resolve: (index) => {
      attemptAt(index);
      gateAt(index).resolve();
    },
    reject: (index, error) => {
      attemptAt(index);
      gateAt(index).reject(error);
    },
  };
}

describe("LLM profile commit queue", () => {
  test("a later back-to-back edit wins", async () => {
    const writer = controlledCallbacks();
    const queue = new LlmProfileCommitQueue(draft(), writer.callbacks);

    queue.acceptEdit(draft({ model: "first-model" }));
    const firstCommit = queue.commit();
    await writer.waitUntilStarted(0);
    queue.acceptEdit(draft({ model: "second-model" }));
    const secondCommit = queue.commit();

    writer.resolve(0);
    await writer.waitUntilStarted(1);
    writer.resolve(1);
    await Promise.all([firstCommit, secondCommit]);

    expect(writer.attempts.map(({ model }) => model)).toEqual(["first-model", "second-model"]);
    expect(writer.lastCompleted()?.model).toBe("second-model");
  });

  test("a failed write is retryable and does not wedge the queue", async () => {
    const writer = controlledCallbacks();
    const failures: unknown[] = [];
    const queue = new LlmProfileCommitQueue(draft(), {
      ...writer.callbacks,
      onSaveFailed: (error) => { failures.push(error); },
    });

    queue.acceptEdit(draft({ model: "retry-model" }));
    const failedCommit = queue.commit();
    await writer.waitUntilStarted(0);
    const failure = new Error("disk unavailable");
    writer.reject(0, failure);
    await failedCommit;

    const retry = queue.commit();
    await writer.waitUntilStarted(1);
    writer.resolve(1);
    await retry;

    queue.acceptEdit(draft({ model: "after-retry" }));
    const nextCommit = queue.commit();
    await writer.waitUntilStarted(2);
    writer.resolve(2);
    await nextCommit;

    expect(failures).toEqual([failure]);
    expect(writer.attempts.map(({ model }) => model)).toEqual([
      "retry-model",
      "retry-model",
      "after-retry",
    ]);
  });

  test("clearing a key while an edit is in flight queues whole profiles", async () => {
    const writer = controlledCallbacks();
    const queue = new LlmProfileCommitQueue(draft(), writer.callbacks);

    queue.acceptEdit(draft({ model: "rotated-profile", api_key: "rotated-key" }));
    const rotation = queue.commit();
    await writer.waitUntilStarted(0);
    queue.acceptEdit(draft({ model: "rotated-profile", api_key: "" }));
    const clear = queue.commit();

    expect(writer.attempts).toHaveLength(1);
    writer.resolve(0);
    await writer.waitUntilStarted(1);
    writer.resolve(1);
    await Promise.all([rotation, clear]);

    expect(writer.attempts).toEqual([
      {
        provider: "openai",
        model: "rotated-profile",
        api_key: "rotated-key",
        base_url: "https://example.test/v1",
      },
      {
        provider: "openai",
        model: "rotated-profile",
        base_url: "https://example.test/v1",
      },
    ]);
  });

  test("writes never overlap and finish before the next starts", async () => {
    const writer = controlledCallbacks();
    const queue = new LlmProfileCommitQueue(draft(), writer.callbacks);

    queue.acceptEdit(draft({ model: "one" }));
    const first = queue.commit();
    await writer.waitUntilStarted(0);
    queue.acceptEdit(draft({ model: "two" }));
    const second = queue.commit();
    queue.acceptEdit(draft({ model: "three" }));
    const third = queue.commit();

    writer.resolve(0);
    await writer.waitUntilStarted(1);
    writer.resolve(1);
    await writer.waitUntilStarted(2);
    writer.resolve(2);
    await Promise.all([first, second, third]);

    expect(writer.maxActive()).toBe(1);
    expect(writer.events).toEqual([
      "start:one",
      "finish:one",
      "start:two",
      "finish:two",
      "start:three",
      "finish:three",
    ]);
  });
});
