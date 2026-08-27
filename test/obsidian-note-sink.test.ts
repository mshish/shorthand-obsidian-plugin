import { describe, expect, test } from "bun:test";
import type { Editor, TFile } from "obsidian";
import type { Section } from "shorthand-core";
import { ObsidianNoteSink, type ActiveMarkdownEditor, type ObsidianNoteApi } from "../src/obsidian-note-sink.js";

const START = "<!-- shorthand:ai:start -->";
const END = "<!-- shorthand:ai:end -->";
const original = `# Meeting\n\n<!-- shorthand:notes -->\nUser's unsaved note\n\n${START}\n## Summary\nOld summary\n${END}\n`;
const revised: readonly Section[] = [{ heading: "Summary", markdown: "New summary" }];

describe("ObsidianNoteSink", () => {
  test("uses the active editor and leaves its user-owned text intact", async () => {
    const file = fakeFile("Meeting.md");
    const editor = fakeEditor(original);
    let processCalls = 0;
    const sink = new ObsidianNoteSink({
      file,
      api: api(file, () => ({ file, editor }), () => { processCalls += 1; }),
    });

    const before = await sink.read();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(await sink.write(revised, before.value.revision)).toMatchObject({ status: "written" });
    expect(editor.getValue()).toContain("New summary");
    expect(editor.getValue()).toContain("User's unsaved note");
    expect(processCalls).toBe(0);
  });

  test("uses Vault.process for a background note", async () => {
    const file = fakeFile("Meeting.md");
    let content = original;
    let processCalls = 0;
    const sink = new ObsidianNoteSink({
      file,
      api: api(file, () => undefined, (transform) => {
        processCalls += 1;
        content = transform(content);
      }),
    });

    const before = await sink.read();
    if (!before.ok) throw new Error(before.error.message);
    expect(await sink.write(revised, before.value.revision)).toMatchObject({ status: "written" });
    expect(content).toContain("New summary");
    expect(processCalls).toBe(1);
  });

  test("reconciles an editor that gains focus during Vault.process without replacing user text", async () => {
    const file = fakeFile("Meeting.md");
    let content = original;
    const editor = fakeEditor(original.replace("User's unsaved note", "User edit made before focus"));
    let active: ActiveMarkdownEditor | undefined;
    const sink = new ObsidianNoteSink({
      file,
      api: api(file, () => active, (transform) => {
        content = transform(content);
        active = { file, editor };
      }),
    });

    const before = await sink.read();
    if (!before.ok) throw new Error(before.error.message);
    expect(await sink.write(revised, before.value.revision)).toMatchObject({ status: "written" });
    expect(content).toContain("New summary");
    expect(editor.getValue()).toContain("New summary");
    expect(editor.getValue()).toContain("User edit made before focus");
  });

  test("follows the same TFile through a rename but rejects a replacement at the old path", async () => {
    const file = fakeFile("Meeting.md");
    const files = new Map<string, TFile>([[file.path, file]]);
    let content = original;
    const sink = new ObsidianNoteSink({
      file,
      api: {
        vault: {
          getFileByPath: (path) => files.get(path) ?? null,
          read: async () => content,
          process: async (_target, transform) => { content = transform(content); return content; },
        },
        activeEditor: () => undefined,
      },
    });
    const before = await sink.read();
    if (!before.ok) throw new Error(before.error.message);
    files.delete("Meeting.md");
    Object.assign(file, { path: "Renamed meeting.md" });
    files.set(file.path, file);
    expect(await sink.write(revised, before.value.revision)).toMatchObject({ status: "written" });

    files.set(file.path, fakeFile(file.path));
    expect(await sink.read()).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

function api(
  file: TFile,
  activeEditor: () => ActiveMarkdownEditor | undefined,
  processBody: (transform: (content: string) => string) => void,
): ObsidianNoteApi {
  return {
    vault: {
      getFileByPath: () => file,
      read: async () => original,
      process: async (_target, transform) => {
        processBody(transform);
        return original;
      },
    },
    activeEditor,
  };
}

function fakeFile(path: string): TFile {
  return { path } as unknown as TFile;
}

function fakeEditor(initial: string): Editor {
  let value = initial;
  return {
    getValue: () => value,
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    replaceRange: (replacement: string, from: { ch: number }, to: { ch: number }) => {
      value = value.slice(0, from.ch) + replacement + value.slice(to.ch);
    },
  } as unknown as Editor;
}
