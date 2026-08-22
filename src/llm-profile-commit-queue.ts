import type { LlmCredentials } from "shorthand-core";
import {
  validateLlmProfileDraft,
  type LlmProfileDraft,
  type MissingLlmProfileField,
} from "./llm-profile-draft.js";

export type LlmProfileCommitCallbacks = Readonly<{
  write(credentials: LlmCredentials): Promise<unknown>;
  onInvalid(missing: readonly MissingLlmProfileField[]): void;
  onSaving(credentials: LlmCredentials): void;
  onSaved(credentials: LlmCredentials, isLatestRevision: boolean): void;
  onSaveFailed(error: unknown): void;
}>;

export class LlmProfileCommitQueue {
  #draft: LlmProfileDraft;
  #revision = 0;
  #lastQueuedRevision = 0;
  #writeQueue: Promise<void> = Promise.resolve();
  readonly #callbacks: LlmProfileCommitCallbacks;

  constructor(initialDraft: LlmProfileDraft, callbacks: LlmProfileCommitCallbacks) {
    this.#draft = initialDraft;
    this.#callbacks = callbacks;
  }

  acceptEdit(draft: LlmProfileDraft): void {
    this.#draft = draft;
    this.#revision += 1;
  }

  async commit(): Promise<void> {
    if (this.#revision === this.#lastQueuedRevision) return;

    const validation = validateLlmProfileDraft(this.#draft);
    if (!validation.ok) {
      this.#callbacks.onInvalid(validation.missing);
      return;
    }

    const committedRevision = this.#revision;
    const credentials = validation.credentials;
    this.#lastQueuedRevision = committedRevision;
    this.#callbacks.onSaving(credentials);
    this.#writeQueue = this.#writeQueue.then(async () => {
      try {
        await this.#callbacks.write(credentials);
        this.#callbacks.onSaved(credentials, this.#revision === committedRevision);
      } catch (error) {
        // Only the latest failed snapshot is retryable; an accepted newer edit already
        // has its own revision and must not be mistaken for the failed write.
        if (this.#revision === committedRevision) this.#lastQueuedRevision = -1;
        this.#callbacks.onSaveFailed(error);
      }
    });
    await this.#writeQueue;
  }
}
