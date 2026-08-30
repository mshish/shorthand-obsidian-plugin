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
export type OpenMarkdownEditor = Readonly<{
  editor: Editor;
  /**
   * Persist the buffer. Obsidian would do this on its own debounce, but a later
   * background write reads the file rather than the buffer, and would then find
   * content that disagrees with what we just wrote.
   */
  save(): Promise<void>;
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
  /**
   * The editor holding this file in any leaf, not merely the focused one:
   * Obsidian keeps an unsaved buffer per leaf, so a note sitting in a split or
   * a background tab can hold keystrokes the file on disk has never seen.
   */
  openEditor(file: TFile): OpenMarkdownEditor | undefined;
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
 * Obsidian-backed note sink. It edits an open note through its Editor so an
 * unsaved buffer is never overwritten; a note open in no leaf is written with
 * Vault.process(), Obsidian's atomic read-transform-write API.
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
    const open = this.#api.openEditor(target);
    if (open !== undefined) return readMarkdownDocument(open.editor.getValue());
    try {
      return readMarkdownDocument(await this.#api.vault.read(target));
    } catch (error) {
      return { ok: false, error: transportError("read", target.path, error) };
    }
  }

  async write(sections: readonly Section[], expectedRevision: string): Promise<SinkWriteResult> {
    const target = this.target();
    if (target === undefined) return { status: "error", error: missingTarget().error };
    const open = this.#api.openEditor(target);
    if (open !== undefined) return this.writeEditor(open, sections, expectedRevision);

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

    // A note can be opened while Vault.process() is awaiting. Reapply only the
    // owned range to that editor buffer; replacing the full text here would
    // discard user edits that have not been saved yet.
    const opened = this.#api.openEditor(target);
    if (opened === undefined || result.status === "error" || result.status === "stale" || result.status === "busy") return result;
    const snapshot = readMarkdownDocument(opened.editor.getValue());
    if (snapshot.ok && snapshot.value.revision === result.revision) return result;
    // A user change in the owned block landed after the atomic Vault write.
    // Do not replace it with the now-stale enhancement result.
    if (!snapshot.ok || snapshot.value.revision !== expectedRevision) return { status: "stale" };
    const reconciled = await this.writeEditor(opened, sections, expectedRevision);
    if (reconciled.status === "stale" || reconciled.status === "error") return reconciled;
    return result.status === "written" ? result : reconciled;
  }

  /** Read the same live-or-vault view used by setup before it mutates anything. */
  async readContent(): Promise<Readonly<{ ok: true; content: string }> | Readonly<{ ok: false; message: string }>> {
    const target = this.target();
    if (target === undefined) return { ok: false, message: missingTarget().error.message };
    const open = this.#api.openEditor(target);
    if (open !== undefined) return { ok: true, content: open.editor.getValue() };
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
    const open = this.#api.openEditor(target);
    if (open !== undefined) return this.scaffoldEditor(open, sections);

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
    const opened = this.#api.openEditor(target);
    if (opened === undefined || result.status === "error") return result;
    const reconciled = await this.scaffoldEditor(opened, sections);
    return reconciled.status === "error" ? reconciled : result.status === "written" ? result : reconciled;
  }

  private async writeEditor(
    open: OpenMarkdownEditor,
    sections: readonly Section[],
    expectedRevision: string,
  ): Promise<SinkWriteResult> {
    const { editor } = open;
    const update = updateMarkdownDocument(editor.getValue(), sections, expectedRevision);
    if (update.status === "error") return { status: "error", error: update.error };
    if (update.status === "stale") return { status: "stale" };
    if (update.status === "written") {
      applyPreservingViewport(editor, update.edit);
      await open.save();
    }
    return { status: update.status, revision: update.revision };
  }

  private async scaffoldEditor(
    open: OpenMarkdownEditor,
    sections: readonly Section[],
  ): Promise<ObsidianScaffoldResult> {
    const { editor } = open;
    const scaffold = scaffoldMarkdownDocument(editor.getValue(), sections);
    if (scaffold.status === "error") return { status: "error", message: scaffold.error.message };
    if (scaffold.status === "written") {
      applyPreservingViewport(editor, scaffold.edit);
      await open.save();
    }
    return { status: scaffold.status };
  }

  private target(): TFile | undefined {
    // TFile instances survive normal rename/move operations and their path is
    // updated by Obsidian. Identity prevents a deleted note recreated at the
    // same path from receiving a delayed capture's writes.
    return this.#api.vault.getFileByPath(this.#file.path) === this.#file ? this.#file : undefined;
  }

}

/**
 * Apply an owned-range edit without moving the reader.
 *
 * The person whose note this is did not ask for this edit and is usually reading
 * the note while a meeting runs. Replacing the whole AI block re-measures every
 * heading and list inside it, and the editor does not reliably keep its scroll
 * anchor across a change that size — the note jumped to the top on every
 * enhancement pass, roughly twice a minute, which is what made live capture
 * unusable to watch. Nothing else restores the viewport: `replaceRange` maps the
 * selection but says nothing about scroll.
 *
 * Capture and restore are deliberately synchronous with no `await` between them.
 * An `await` there would open a window in which the user scrolls on their own and
 * is then yanked back to where they were before — a worse bug than this one, and
 * the reason the restore does not also span the `save()` that follows.
 *
 * The selection is left alone on purpose: the editor already maps it through the
 * change, and restoring a captured copy would fight a user typing during the write.
 */
function applyPreservingViewport(
  editor: Editor,
  edit: Readonly<{ from: number; to: number; replacement: string }>,
): void {
  const scroll = editor.getScrollInfo();
  editor.replaceRange(edit.replacement, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to));
  editor.scrollTo(scroll.left, scroll.top);
}

function missingTarget(): Readonly<{ ok: false; error: ReturnType<typeof sinkError> }> {
  return { ok: false, error: sinkError("not-found", "The meeting note was deleted or replaced while Shorthand was writing it.") };
}

function transportError(action: string, path: string, cause: unknown) {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return sinkError("transport", `Could not ${action} ${path}${detail}`, cause);
}
