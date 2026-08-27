import type { Editor, TFile } from "obsidian";
import {
  readMarkdownDocument,
  scaffoldMarkdownDocument,
  updateMarkdownDocument,
} from "shorthand-core/markdown";
import {
  sinkError,
  type NoteSink,
  type Section,
  type SinkReadResult,
  type SinkWriteResult,
} from "shorthand-core";

/** The live editor surface needed to preserve unsaved user input. */
export type ActiveMarkdownEditor = Readonly<{
  file: TFile;
  editor: Editor;
}>;

/**
 * The small, type-only Obsidian surface used by the note transport.
 *
 * Keeping this injected makes the transport testable without loading Obsidian's
 * runtime module. main.ts supplies these directly from the app.
 */
export type ObsidianNoteApi = Readonly<{
  vault: Readonly<{
    getFileByPath(path: string): TFile | null;
    read(file: TFile): Promise<string>;
    process(file: TFile, transform: (content: string) => string): Promise<string>;
  }>;
  activeEditor(): ActiveMarkdownEditor | undefined;
}>;

export type ObsidianNoteSinkOptions = Readonly<{
  api: ObsidianNoteApi;
  file: TFile;
  agentContext?: Readonly<{ cwd: string }>;
}>;

export type ObsidianScaffoldResult =
  | Readonly<{ status: "written" | "unchanged" }>
  | Readonly<{ status: "error"; message: string }>;

/**
 * Obsidian-backed note sink. It edits an active note through its Editor so an
 * unsaved buffer is never overwritten; background writes use Vault.process(),
 * Obsidian's atomic read-transform-write API.
 */
export class ObsidianNoteSink implements NoteSink {
  readonly #api: ObsidianNoteApi;
  readonly #file: TFile;
  readonly agentContext?: Readonly<{ cwd: string }>;

  constructor(options: ObsidianNoteSinkOptions) {
    this.#api = options.api;
    this.#file = options.file;
    if (options.agentContext !== undefined) this.agentContext = options.agentContext;
  }

  get describe(): string {
    return this.#file.path;
  }

  async read(): Promise<SinkReadResult> {
    const target = this.target();
    if (target === undefined) return missingTarget();
    const active = this.activeEditor(target);
    if (active !== undefined) return readMarkdownDocument(active.editor.getValue());
    try {
      return readMarkdownDocument(await this.#api.vault.read(target));
    } catch (error) {
      return { ok: false, error: transportError("read", target.path, error) };
    }
  }

  async write(sections: readonly Section[], expectedRevision: string): Promise<SinkWriteResult> {
    const target = this.target();
    if (target === undefined) return { status: "error", error: missingTarget().error };
    const active = this.activeEditor(target);
    if (active !== undefined) return this.writeEditor(active.editor, sections, expectedRevision);

    let result: SinkWriteResult | undefined;
    try {
      await this.#api.vault.process(target, (content) => {
        const update = updateMarkdownDocument(content, sections, expectedRevision);
        if (update.status === "error") {
          result = { status: "error", error: update.error };
          return content;
        }
        if (update.status === "stale") {
          result = { status: "stale" };
          return content;
        }
        result = { status: update.status, revision: update.revision };
        return update.status === "written" ? update.content : content;
      });
    } catch (error) {
      return { status: "error", error: transportError("write", target.path, error) };
    }
    if (result === undefined) {
      return { status: "error", error: sinkError("transport", `Obsidian did not complete the write for ${target.path}.`) };
    }
    if (this.target() === undefined) return { status: "error", error: missingTarget().error };

    // A note can receive focus while Vault.process() is awaiting. Reapply only
    // the owned range to the old editor buffer; replacing the full text here
    // would discard user edits that have not been saved yet.
    const focused = this.activeEditor(target);
    if (focused === undefined || result.status === "error" || result.status === "stale" || result.status === "busy") return result;
    const focusedSnapshot = readMarkdownDocument(focused.editor.getValue());
    if (focusedSnapshot.ok && focusedSnapshot.value.revision === result.revision) return result;
    // A user change in the owned block landed after the atomic Vault write.
    // Do not replace it with the now-stale enhancement result.
    if (!focusedSnapshot.ok || focusedSnapshot.value.revision !== expectedRevision) return { status: "stale" };
    const reconciled = this.writeEditor(focused.editor, sections, expectedRevision);
    if (reconciled.status === "stale" || reconciled.status === "error") return reconciled;
    return result.status === "written" ? result : reconciled;
  }

  /** Read the same live-or-vault view used by setup before it mutates anything. */
  async readContent(): Promise<Readonly<{ ok: true; content: string }> | Readonly<{ ok: false; message: string }>> {
    const target = this.target();
    if (target === undefined) return { ok: false, message: missingTarget().error.message };
    const active = this.activeEditor(target);
    if (active !== undefined) return { ok: true, content: active.editor.getValue() };
    try {
      return { ok: true, content: await this.#api.vault.read(target) };
    } catch (error) {
      return { ok: false, message: transportError("read", target.path, error).message };
    }
  }

  /** Add marker scaffolding with the same live-editor / Vault.process routing. */
  async scaffold(sections: readonly Section[]): Promise<ObsidianScaffoldResult> {
    const target = this.target();
    if (target === undefined) return { status: "error", message: missingTarget().error.message };
    const active = this.activeEditor(target);
    if (active !== undefined) return this.scaffoldEditor(active.editor, sections);

    let result: ObsidianScaffoldResult | undefined;
    try {
      await this.#api.vault.process(target, (content) => {
        const scaffold = scaffoldMarkdownDocument(content, sections);
        if (scaffold.status === "error") {
          result = { status: "error", message: scaffold.error.message };
          return content;
        }
        result = { status: scaffold.status };
        return scaffold.status === "written" ? scaffold.content : content;
      });
    } catch (error) {
      return { status: "error", message: transportError("scaffold", target.path, error).message };
    }
    if (result === undefined) return { status: "error", message: `Obsidian did not complete scaffolding ${target.path}.` };
    if (this.target() === undefined) return { status: "error", message: missingTarget().error.message };
    const focused = this.activeEditor(target);
    if (focused === undefined || result.status === "error") return result;
    const reconciled = this.scaffoldEditor(focused.editor, sections);
    return reconciled.status === "error" ? reconciled : result.status === "written" ? result : reconciled;
  }

  private writeEditor(editor: Editor, sections: readonly Section[], expectedRevision: string): SinkWriteResult {
    const update = updateMarkdownDocument(editor.getValue(), sections, expectedRevision);
    if (update.status === "error") return { status: "error", error: update.error };
    if (update.status === "stale") return { status: "stale" };
    if (update.status === "written") {
      editor.replaceRange(update.edit.replacement, editor.offsetToPos(update.edit.from), editor.offsetToPos(update.edit.to));
    }
    return { status: update.status, revision: update.revision };
  }

  private scaffoldEditor(editor: Editor, sections: readonly Section[]): ObsidianScaffoldResult {
    const scaffold = scaffoldMarkdownDocument(editor.getValue(), sections);
    if (scaffold.status === "error") return { status: "error", message: scaffold.error.message };
    if (scaffold.status === "written") {
      editor.replaceRange(scaffold.edit.replacement, editor.offsetToPos(scaffold.edit.from), editor.offsetToPos(scaffold.edit.to));
    }
    return { status: scaffold.status };
  }

  private target(): TFile | undefined {
    // TFile instances survive normal rename/move operations and their path is
    // updated by Obsidian. Identity prevents a deleted note recreated at the
    // same path from receiving a delayed capture's writes.
    return this.#api.vault.getFileByPath(this.#file.path) === this.#file ? this.#file : undefined;
  }

  private activeEditor(target: TFile): ActiveMarkdownEditor | undefined {
    const active = this.#api.activeEditor();
    return active?.file === target ? active : undefined;
  }
}

function missingTarget(): Readonly<{ ok: false; error: ReturnType<typeof sinkError> }> {
  return { ok: false, error: sinkError("not-found", "The meeting note was deleted or replaced while Shorthand was writing it.") };
}

function transportError(action: string, path: string, cause: unknown) {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return sinkError("transport", `Could not ${action} ${path}${detail}`, cause);
}
