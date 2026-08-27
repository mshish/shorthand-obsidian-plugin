import type { Editor, TFile } from "obsidian";
import type { SidecarStore } from "shorthand-core";

/** The live editor surface needed when a transcript sidecar is open. */
export type OpenSidecarEditor = Readonly<{
  editor: Pick<Editor, "getValue" | "replaceRange" | "offsetToPos">;
  /**
   * Persist the buffer. Without this the next flush that finds the sidecar
   * closed would read a file still holding the previous content, which core
   * reports as the sidecar having been changed outside Shorthand.
   */
  save(): Promise<void>;
}>;

/**
 * The small Vault surface used by transcript persistence. Keeping it injected
 * lets the store be tested without loading Obsidian's runtime module.
 */
export type ObsidianSidecarApi = Readonly<{
  vault: Readonly<{
    getFileByPath(path: string): TFile | null;
    getAbstractFileByPath(path: string): unknown;
    createFolder(path: string): Promise<unknown>;
    create(path: string, content: string): Promise<TFile>;
    read(file: TFile): Promise<string>;
    process(file: TFile, transform: (content: string) => string): Promise<string>;
  }>;
  /** The editor holding this file in any leaf, focused or not. */
  openEditor(file: TFile): OpenSidecarEditor | undefined;
}>;

export type ObsidianSidecarStoreOptions = Readonly<{
  api: ObsidianSidecarApi;
  /** A vault-relative Markdown path, never an operating-system path. */
  path: string;
  /** A resolved existing file, if MetadataCache already found the wikilink target. */
  file?: TFile;
}>;

/**
 * Vault-backed `SidecarStore`. Once a sidecar is observed or created, its
 * `TFile` identity follows normal Obsidian moves and renames. A deleted file
 * recreated at the old path is deliberately not accepted as the same capture.
 */
export class ObsidianSidecarStore implements SidecarStore {
  readonly #api: ObsidianSidecarApi;
  readonly #requestedPath: string;
  #file: TFile | undefined;

  constructor(options: ObsidianSidecarStoreOptions) {
    this.#api = options.api;
    this.#requestedPath = options.path;
    this.#file = options.file;
  }

  get describe(): string {
    return this.#file?.path ?? this.#requestedPath;
  }

  async process<T>(
    transform: (current: string | undefined) => Readonly<{ content: string; value: T }>,
  ): Promise<T> {
    let target = this.target();
    if (target === undefined && this.#file !== undefined) {
      throw new Error(`Transcript sidecar was deleted or replaced while Shorthand was writing it: ${this.#file.path}`);
    }
    if (target === undefined) {
      const existing = this.#api.vault.getFileByPath(this.#requestedPath);
      if (existing !== null) {
        this.#file = existing;
        target = existing;
      }
    }

    if (target === undefined) {
      const initial = transform(undefined);
      const created = await this.create(initial.content);
      if (created.created) return initial.value;
      // Another writer created the target first. Run the same pure callback
      // against its actual content so SidecarWriter retains its sentinel and
      // resume checks instead of treating the race as a blind overwrite.
      target = created.file;
    }

    const open = this.#api.openEditor(target);
    if (open !== undefined) {
      const current = open.editor.getValue();
      const candidate = transform(current);
      if (candidate.content !== current) {
        // A transcript flushes several times a second. Replacing the whole
        // document would reset the reader's cursor, selection and scroll that
        // often, so touch only the range that actually differs.
        const edit = minimalEdit(current, candidate.content);
        open.editor.replaceRange(
          edit.replacement,
          open.editor.offsetToPos(edit.from),
          open.editor.offsetToPos(edit.to),
        );
        await open.save();
      }
      return candidate.value;
    }

    let committed: T | undefined;
    let completed = false;
    await this.#api.vault.process(target, (current) => {
      const candidate = transform(current);
      committed = candidate.value;
      completed = true;
      return candidate.content;
    });
    if (!completed) throw new Error(`Obsidian did not complete transcript sidecar write for ${target.path}.`);
    if (this.target() === undefined) {
      throw new Error(`Transcript sidecar was deleted or replaced while Shorthand was writing it: ${target.path}`);
    }
    return committed as T;
  }

  private target(): TFile | undefined {
    const file = this.#file;
    if (file === undefined) return undefined;
    return this.#api.vault.getFileByPath(file.path) === file ? file : undefined;
  }


  private async create(content: string): Promise<Readonly<{ file: TFile; created: boolean }>> {
    const folder = parentPath(this.#requestedPath);
    if (folder !== "") await this.ensureFolder(folder);
    try {
      const created = await this.#api.vault.create(this.#requestedPath, content);
      this.#file = created;
      return { file: created, created: true };
    } catch (error) {
      // A concurrent creator is normal. Adopt the actual Vault object, then
      // let SidecarWriter's first callback inspect its sentinel/resume state.
      const existing = this.#api.vault.getFileByPath(this.#requestedPath);
      if (existing === null) throw error;
      this.#file = existing;
      return { file: existing, created: false };
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    const existing = this.#api.vault.getAbstractFileByPath(path);
    if (existing !== null && existing !== undefined) return;
    try {
      await this.#api.vault.createFolder(path);
    } catch (error) {
      if (this.#api.vault.getAbstractFileByPath(path) === null) throw error;
    }
  }
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/**
 * The one contiguous range in `current` that has to change to become `next`.
 * Offsets are UTF-16 code units, which is what `Editor.offsetToPos()` expects;
 * the boundaries back off a step rather than split a surrogate pair.
 */
function minimalEdit(current: string, next: string): Readonly<{ from: number; to: number; replacement: string }> {
  let prefix = 0;
  const shortest = Math.min(current.length, next.length);
  while (prefix < shortest && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;
  if (prefix > 0 && isHighSurrogate(current.charCodeAt(prefix - 1))) prefix -= 1;

  let suffix = 0;
  while (
    suffix < shortest - prefix
    && current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) suffix += 1;
  if (suffix > 0 && isLowSurrogate(current.charCodeAt(current.length - suffix))) suffix -= 1;

  return { from: prefix, to: current.length - suffix, replacement: next.slice(prefix, next.length - suffix) };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
