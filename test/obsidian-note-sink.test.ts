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
    const sink = new ObsidianNoteSink({ file, api: vault.api(() => open), scheduleFrame: frameRunner(open) });

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

  test("leaves the reader where they were when it rewrites the block", async () => {
    // The note jumped to the top on every enhancement pass — roughly twice a minute
    // during a meeting — because replacing the whole AI block re-measures everything
    // inside it and the editor does not keep its scroll anchor across a change that
    // size. The person reading the note did not ask for the edit and must not be moved.
    const vault = memoryVault(original);
    const file = vault.add("Meeting.md");
    const open = openEditor(original, { top: 420, left: 0 });
    const sink = new ObsidianNoteSink({ file, api: vault.api(() => open), scheduleFrame: frameRunner(open) });

    const before = await sink.read();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(await sink.write(revised, before.value.revision)).toMatchObject({ status: "written" });

    // Twice, and both matter. CodeMirror measures layout in a frame it schedules
    // itself, so a synchronous-only restore lands before that phase and is
    // overwritten by it; a scheduled-only restore leaves the jump visible for one
    // frame. See applyPreservingViewport.
    expect(open.scrollTos).toEqual([{ top: 420, left: 0 }, { top: 420, left: 0 }]);
    expect(open.scrolledAfterFrame).toBe(true);
    // Restoring before the edit would be a no-op dressed as a fix.
    expect(open.scrolledBeforeEdit).toBe(false);
  });

  test("does not touch the viewport when it writes nothing", async () => {
    // An unchanged block must not produce a scroll call at all: every restore is a
    // chance to fight a user who scrolled themselves.
    const vault = memoryVault(original);
    const file = vault.add("Meeting.md");
    const open = openEditor(original, { top: 420, left: 0 });
    const sink = new ObsidianNoteSink({ file, api: vault.api(() => open), scheduleFrame: frameRunner(open) });

    const before = await sink.read();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const unchanged: readonly Section[] = [{ heading: "Summary", markdown: "Old summary" }];
    expect(await sink.write(unchanged, before.value.revision)).toMatchObject({ status: "unchanged" });
    expect(open.scrollTos).toEqual([]);
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

function openEditor(
  initial: string,
  scroll: Readonly<{ top: number; left: number }> = { top: 0, left: 0 },
): OpenMarkdownEditor & { saves: number; scrollTos: readonly { top: number; left: number }[]; scrolledBeforeEdit: boolean; scrolledAfterFrame: boolean; markFramed(): void } {
  let value = initial;
  let saves = 0;
  let edited = false;
  const scrollTos: { top: number; left: number }[] = [];
  // True if any scroll was restored before the edit landed, which would mean the
  // restore is not bracketing the change at all.
  let scrolledBeforeEdit = false;
  let scrolledAfterFrame = false;
  let framed = false;
  const editor = {
    getValue: () => value,
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    getScrollInfo: () => ({ ...scroll }),
    scrollTo: (left?: number | null, top?: number | null) => {
      if (!edited) scrolledBeforeEdit = true;
      if (framed) scrolledAfterFrame = true;
      scrollTos.push({ left: left ?? 0, top: top ?? 0 });
    },
    replaceRange: (replacement: string, from: { ch: number }, to: { ch: number }) => {
      edited = true;
      value = value.slice(0, from.ch) + replacement + value.slice(to.ch);
    },
  } as unknown as Editor;
  return {
    editor,
    save: async () => { saves += 1; },
    get saves() { return saves; },
    get scrollTos() { return scrollTos; },
    get scrolledBeforeEdit() { return scrolledBeforeEdit; },
    get scrolledAfterFrame() { return scrolledAfterFrame; },
    markFramed() { framed = true; },
  };
}

/**
 * Runs the scheduled restore immediately, so a test need not wait a real frame,
 * marking the boundary first so the mock can tell a synchronous restore from the
 * one that has to survive CodeMirror's measure phase.
 */
function frameRunner(open: { markFramed(): void }): (run: () => void) => void {
  return (run) => { open.markFramed(); run(); };
}
