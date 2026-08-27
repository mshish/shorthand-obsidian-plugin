import { describe, expect, test } from "bun:test";
import type { Editor, TFile } from "obsidian";
import type { Section } from "shorthand-core";
import { ObsidianNoteSink, type ObsidianNoteApi, type OpenMarkdownEditor } from "../src/obsidian-note-sink.js";

const START = "<!-- shorthand:ai:start -->";
const END = "<!-- shorthand:ai:end -->";
const original = `# Meeting\n\n<!-- shorthand:notes -->\nUser's unsaved note\n\n${START}\n## Summary\nOld summary\n${END}\n`;
const unmarked = "# Meeting\n\nUser's rough notes\n";
const revised: readonly Section[] = [{ heading: "Summary", markdown: "New summary" }];

describe("ObsidianNoteSink", () => {
  test("uses an open editor and leaves its user-owned text intact", async () => {
    const vault = memoryVault(original);
    const file = vault.add("Meeting.md");
    const open = openEditor(original);
    const sink = new ObsidianNoteSink({ file, api: vault.api(() => open) });

    const before = await sink.read();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(await sink.write(revised, before.value.revision)).toMatchObject({ status: "written" });
    expect(open.editor.getValue()).toContain("New summary");
    expect(open.editor.getValue()).toContain("User's unsaved note");
    expect(vault.processCalls).toBe(0);
    // Without the save, a later background write would read a file still holding
    // the old block and mistake our own edit for someone else's.
    expect(open.saves).toBe(1);
  });

  test("asks about the note it owns, not about whichever note has focus", async () => {
    const vault = memoryVault(original);
    const file = vault.add("Meeting.md");
    const other = vault.add("Other.md", "unrelated");
    const open = openEditor(original);
    const asked: TFile[] = [];
    const sink = new ObsidianNoteSink({
      file,
      api: vault.api((target) => {
        asked.push(target);
        return target === file ? open : undefined;
      }),
    });

    const before = await sink.read();
    if (!before.ok) throw new Error(before.error.message);
    expect(asked).toEqual([file]);
    expect(asked).not.toContain(other);
  });

  test("uses Vault.process for a note open in no leaf", async () => {
    const vault = memoryVault(original);
    const file = vault.add("Meeting.md");
    const sink = new ObsidianNoteSink({ file, api: vault.api(() => undefined) });

    const before = await sink.read();
    if (!before.ok) throw new Error(before.error.message);
    expect(await sink.write(revised, before.value.revision)).toMatchObject({ status: "written" });
    expect(vault.content.get(file.path)).toContain("New summary");
    expect(vault.processCalls).toBe(1);
  });

  test("reconciles an editor opened during Vault.process without replacing user text", async () => {
    const vault = memoryVault(original);
    const file = vault.add("Meeting.md");
    const open = openEditor(original.replace("User's unsaved note", "User edit made before the note opened"));
    let opened: OpenMarkdownEditor | undefined;
    const sink = new ObsidianNoteSink({
      file,
      api: vault.api(() => opened, () => { opened = open; }),
    });

    const before = await sink.read();
    if (!before.ok) throw new Error(before.error.message);
    expect(await sink.write(revised, before.value.revision)).toMatchObject({ status: "written" });
    expect(vault.content.get(file.path)).toContain("New summary");
    expect(open.editor.getValue()).toContain("New summary");
    expect(open.editor.getValue()).toContain("User edit made before the note opened");
  });

  test("reports stale rather than overwriting an owned block a user changed mid-write", async () => {
    const vault = memoryVault(original);
    const file = vault.add("Meeting.md");
    // The buffer that appears mid-write holds a third revision: neither the one
    // we expected nor the one we just committed. Nothing may be applied to it.
    const open = openEditor(original.replace("Old summary", "The user typed this inside the AI block"));
    let opened: OpenMarkdownEditor | undefined;
    const sink = new ObsidianNoteSink({
      file,
      api: vault.api(() => opened, () => { opened = open; }),
    });

    const before = await sink.read();
    if (!before.ok) throw new Error(before.error.message);
    expect(await sink.write(revised, before.value.revision)).toMatchObject({ status: "stale" });
    expect(open.editor.getValue()).toContain("The user typed this inside the AI block");
    expect(open.editor.getValue()).not.toContain("New summary");
    expect(open.saves).toBe(0);
  });

  test("reports stale when the note changed before the write reached the vault", async () => {
    const vault = memoryVault(original);
    const file = vault.add("Meeting.md");
    const sink = new ObsidianNoteSink({ file, api: vault.api(() => undefined) });

    const before = await sink.read();
    if (!before.ok) throw new Error(before.error.message);
    vault.content.set(file.path, original.replace("Old summary", "Someone else's summary"));
    expect(await sink.write(revised, before.value.revision)).toMatchObject({ status: "stale" });
    expect(vault.content.get(file.path)).toContain("Someone else's summary");
  });

  test("maps an Obsidian failure to a transport error naming the note", async () => {
    const vault = memoryVault(original);
    const file = vault.add("Meeting.md");
    const base = vault.api(() => undefined);
    const sink = new ObsidianNoteSink({
      file,
      api: {
        ...base,
        vault: { ...base.vault, process: async () => { throw new Error("EACCES: permission denied"); } },
      },
    });

    const result = await sink.write(revised, "any-revision");
    expect(result).toMatchObject({ status: "error", error: { code: "transport" } });
    if (result.status !== "error") return;
    expect(result.error.message).toContain("Meeting.md");
    expect(result.error.message).toContain("permission denied");
  });

  test("scaffolds through the vault and through an open editor", async () => {
    const vault = memoryVault(unmarked);
    const background = vault.add("Background.md");
    const backgroundSink = new ObsidianNoteSink({ file: background, api: vault.api(() => undefined) });
    expect(await backgroundSink.scaffold(revised)).toMatchObject({ status: "written" });
    expect(vault.content.get(background.path)).toContain(START);
    expect(vault.content.get(background.path)).toContain(END);
    expect(vault.content.get(background.path)).toContain("User's rough notes");
    expect(await backgroundSink.scaffold(revised)).toMatchObject({ status: "unchanged" });

    const opened = vault.add("Opened.md");
    const open = openEditor(unmarked);
    const openSink = new ObsidianNoteSink({
      file: opened,
      api: vault.api((target) => target === opened ? open : undefined),
    });
    expect(await openSink.scaffold(revised)).toMatchObject({ status: "written" });
    expect(open.editor.getValue()).toContain(START);
    expect(open.editor.getValue()).toContain("User's rough notes");
    expect(open.saves).toBe(1);
  });

  test("follows the same TFile through a rename but rejects a replacement at the old path", async () => {
    const vault = memoryVault(original);
    const file = vault.add("Meeting.md");
    const sink = new ObsidianNoteSink({ file, api: vault.api(() => undefined) });

    const before = await sink.read();
    if (!before.ok) throw new Error(before.error.message);
    vault.rename(file, "Renamed meeting.md");
    expect(await sink.write(revised, before.value.revision)).toMatchObject({ status: "written" });
    expect(vault.content.get("Renamed meeting.md")).toContain("New summary");

    // Deleted, then recreated at the same path: a different TFile, so a capture
    // still running must not pour its enhancement into the new note.
    vault.files.set(file.path, fakeFile(file.path));
    expect(await sink.read()).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await sink.write(revised, before.value.revision)).toMatchObject({
      status: "error",
      error: { code: "not-found" },
    });
  });
});

function memoryVault(initial: string): {
  files: Map<string, TFile>;
  content: Map<string, string>;
  processCalls: number;
  add(path: string, value?: string): TFile;
  rename(file: TFile, path: string): void;
  api(open: (file: TFile) => OpenMarkdownEditor | undefined, afterProcess?: () => void): ObsidianNoteApi;
} {
  const files = new Map<string, TFile>();
  const content = new Map<string, string>();
  let processCalls = 0;
  const add = (path: string, value = initial): TFile => {
    const file = fakeFile(path);
    files.set(path, file);
    content.set(path, value);
    return file;
  };
  return {
    files,
    content,
    get processCalls() { return processCalls; },
    add,
    rename: (file, path) => {
      const previous = file.path;
      const value = content.get(previous) ?? "";
      files.delete(previous);
      content.delete(previous);
      Object.assign(file, { path });
      files.set(path, file);
      content.set(path, value);
    },
    // Path-accurate on purpose: a fake that answered every path would hide a
    // regression in the identity check this transport depends on.
    api: (open, afterProcess) => ({
      vault: {
        getFileByPath: (path) => files.get(path) ?? null,
        read: async (file) => content.get(file.path) ?? "",
        process: async (file, transform) => {
          processCalls += 1;
          const next = transform(content.get(file.path) ?? "");
          content.set(file.path, next);
          afterProcess?.();
          return next;
        },
      },
      openEditor: open,
    }),
  };
}

function fakeFile(path: string): TFile {
  return { path } as unknown as TFile;
}

function openEditor(initial: string): OpenMarkdownEditor & { saves: number } {
  let value = initial;
  let saves = 0;
  const editor = {
    getValue: () => value,
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    replaceRange: (replacement: string, from: { ch: number }, to: { ch: number }) => {
      value = value.slice(0, from.ch) + replacement + value.slice(to.ch);
    },
  } as unknown as Editor;
  return {
    editor,
    save: async () => { saves += 1; },
    get saves() { return saves; },
  };
}
