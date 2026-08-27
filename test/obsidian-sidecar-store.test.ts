import { describe, expect, test } from "bun:test";
import type { Editor, TFile } from "obsidian";
import { SidecarWriter } from "shorthand-core";
import {
  ObsidianSidecarStore,
  type ObsidianSidecarApi,
  type OpenSidecarEditor,
} from "../src/obsidian-sidecar-store.js";

const SENTINEL = "# Shorthand Transcript";

describe("ObsidianSidecarStore", () => {
  test("creates a vault-relative sidecar and its parent folders", async () => {
    const vault = memoryVault();
    const store = new ObsidianSidecarStore({ api: vault.api(), path: "Calls/2026/Transcript.md" });

    await expect(store.process((current) => {
      expect(current).toBeUndefined();
      return { content: SENTINEL, value: "created" };
    })).resolves.toBe("created");

    expect(vault.folders).toContain("Calls/2026");
    expect(vault.content.get("Calls/2026/Transcript.md")).toBe(SENTINEL);
    expect(store.describe).toBe("Calls/2026/Transcript.md");
  });

  test("uses Vault.process for a sidecar open in no leaf", async () => {
    const vault = memoryVault();
    const file = vault.add("Calls/Transcript.md", "before");
    const store = new ObsidianSidecarStore({ api: vault.api(), path: file.path, file });

    await expect(store.process((current) => ({ content: `${current}\nafter`, value: 7 }))).resolves.toBe(7);
    expect(vault.processCalls).toBe(1);
    expect(vault.content.get(file.path)).toBe("before\nafter");
  });

  test("edits an open sidecar in place instead of replacing the whole document", async () => {
    const vault = memoryVault();
    const file = vault.add("Calls/Transcript.md", "saved");
    const open = openEditor(`${SENTINEL}\n\nfirst line\n\nsecond line`);
    const store = new ObsidianSidecarStore({ path: file.path, file, api: vault.api(() => open) });

    await expect(store.process((current) => ({ content: `${current}\n\nthird line`, value: "editor" })))
      .resolves.toBe("editor");

    expect(open.editor.getValue()).toBe(`${SENTINEL}\n\nfirst line\n\nsecond line\n\nthird line`);
    // A transcript flushes several times a second; replacing the document each
    // time would reset the reader's cursor and scroll position.
    const appendedAt = `${SENTINEL}\n\nfirst line\n\nsecond line`.length;
    expect(open.edits).toEqual([{ from: appendedAt, to: appendedAt, replacement: "\n\nthird line" }]);
    expect(open.saves).toBe(1);
    expect(vault.processCalls).toBe(0);
  });

  test.each([
    ["appends", "one\ntwo", "one\ntwo\nthree", { from: 7, to: 7, replacement: "\nthree" }],
    ["replaces in the middle", "one\ntwo\nthree", "one\nTWO\nthree", { from: 4, to: 7, replacement: "TWO" }],
    ["deletes from the middle", "one\ntwo\nthree", "one\nthree", { from: 5, to: 9, replacement: "" }],
    ["rewrites everything", "one", "two", { from: 0, to: 3, replacement: "two" }],
    // Both strings end in the same low surrogate, so a naive suffix scan would
    // cut a character in half.
    ["keeps surrogate pairs whole", "a\u{1F600}b", "a\u{1FA00}b", { from: 1, to: 3, replacement: "\u{1FA00}" }],
  ])("%s with one minimal edit", async (_label, before, after, expected) => {
    const vault = memoryVault();
    const file = vault.add("Calls/Transcript.md", "saved");
    const open = openEditor(before);
    const store = new ObsidianSidecarStore({ path: file.path, file, api: vault.api(() => open) });

    await store.process(() => ({ content: after, value: null }));
    expect(open.editor.getValue()).toBe(after);
    expect(open.edits).toEqual([expected]);
  });

  test("leaves an unchanged open sidecar untouched", async () => {
    const vault = memoryVault();
    const file = vault.add("Calls/Transcript.md", "saved");
    const open = openEditor(SENTINEL);
    const store = new ObsidianSidecarStore({ path: file.path, file, api: vault.api(() => open) });

    await store.process((current) => ({ content: current ?? "", value: "same" }));
    expect(open.edits).toEqual([]);
    expect(open.saves).toBe(0);
  });

  test("adopts a sidecar another writer created first and re-runs the transform against it", async () => {
    const vault = memoryVault();
    const store = new ObsidianSidecarStore({ api: vault.api(), path: "Calls/Transcript.md" });
    // Whoever wins the create race owns the file; the loser must look at what is
    // actually there rather than assume its own first draft landed.
    vault.onCreate = () => { vault.add("Calls/Transcript.md", `${SENTINEL}\n\nfrom the other writer`); };

    const seen: (string | undefined)[] = [];
    const value = await store.process((current) => {
      seen.push(current);
      return { content: `${current ?? ""}\n\nours`, value: current === undefined ? "first" : "adopted" };
    });

    expect(seen).toEqual([undefined, `${SENTINEL}\n\nfrom the other writer`]);
    expect(value).toBe("adopted");
    expect(vault.content.get("Calls/Transcript.md")).toBe(`${SENTINEL}\n\nfrom the other writer\n\nours`);
  });

  test("follows a TFile rename but rejects a replacement at the old path", async () => {
    const vault = memoryVault();
    const file = vault.add("Calls/Transcript.md", "before");
    const store = new ObsidianSidecarStore({ api: vault.api(), path: file.path, file });

    vault.rename(file, "Calls/Renamed transcript.md");
    await expect(store.process((current) => ({ content: `${current}\nafter`, value: "renamed" })))
      .resolves.toBe("renamed");
    expect(store.describe).toBe("Calls/Renamed transcript.md");

    vault.files.set(file.path, fakeFile(file.path));
    await expect(store.process((current) => ({ content: current ?? "", value: "replacement" })))
      .rejects.toThrow("deleted or replaced");
  });
});

// Core owns the sentinel, the resume header and the coalescing; the plugin owns
// the transport. These run the real writer over the real store so that pairing
// cannot drift apart silently.
describe("ObsidianSidecarStore under SidecarWriter", () => {
  test("creates, coalesces and then resumes an existing transcript", async () => {
    const vault = memoryVault();
    const first = new SidecarWriter("Calls/Transcript.md", { store: store(vault), flushIntervalMs: 5_000 });
    first.apply(update("hello"));
    first.apply(update("hello", "hello there"));
    await first.close();

    const created = vault.content.get("Calls/Transcript.md") ?? "";
    expect(created.split("\n", 1)[0]).toBe(SENTINEL);
    expect(created).toContain("hello there");
    // Coalesced: the superseded snapshot is not appended a second time.
    expect(created.match(/hello there/g)).toHaveLength(1);

    const resumed = new SidecarWriter("Calls/Transcript.md", {
      store: store(vault, vault.files.get("Calls/Transcript.md")),
      flushIntervalMs: 5_000,
    });
    resumed.apply(update("second session"));
    await resumed.close();

    const after = vault.content.get("Calls/Transcript.md") ?? "";
    expect(after).toContain("hello there");
    expect(after).toContain("## Resumed ");
    expect(after).toContain("second session");
  });

  test("refuses to overwrite a note that is not a transcript", async () => {
    const vault = memoryVault();
    const existing = vault.add("Calls/Someone's note.md", "# Not a transcript\n\nreal content");
    const writer = new SidecarWriter("Calls/Someone's note.md", {
      store: store(vault, existing),
      flushIntervalMs: 5_000,
    });
    writer.on("writeError", () => {});
    writer.apply(update("transcript text"));

    await expect(writer.close()).rejects.toThrow("first line must be");
    expect(vault.content.get(existing.path)).toBe("# Not a transcript\n\nreal content");
  });
});

function store(vault: MemoryVault, file?: TFile): ObsidianSidecarStore {
  return new ObsidianSidecarStore({
    api: vault.api(),
    path: "Calls/Transcript.md",
    ...(file === undefined ? {} : { file }),
  });
}

function update(...texts: readonly string[]): Parameters<SidecarWriter["apply"]>[0] {
  return {
    snapshot: {
      connectionGeneration: 1,
      session: 1,
      status: "complete",
      speakers: [],
      commits: texts.map((text, index) => ({
        speaker: "Speaker 1",
        text,
        commitMs: index * 1_000,
      })),
    },
  } as unknown as Parameters<SidecarWriter["apply"]>[0];
}

type MemoryVault = {
  files: Map<string, TFile>;
  content: Map<string, string>;
  folders: string[];
  processCalls: number;
  onCreate?: () => void;
  add(path: string, content: string): TFile;
  rename(file: TFile, path: string): void;
  api(open?: (file: TFile) => OpenSidecarEditor | undefined): ObsidianSidecarApi;
};

function memoryVault(): MemoryVault {
  const files = new Map<string, TFile>();
  const content = new Map<string, string>();
  const folders: string[] = [];
  let processCalls = 0;
  const add = (path: string, value: string): TFile => {
    const file = fakeFile(path);
    files.set(path, file);
    content.set(path, value);
    return file;
  };
  const vault: MemoryVault = {
    files,
    content,
    folders,
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
    api: (open) => ({
      vault: {
        getFileByPath: (path) => files.get(path) ?? null,
        getAbstractFileByPath: (path) => folders.includes(path) ? {} : null,
        createFolder: async (path) => { folders.push(path); return {}; },
        create: async (path, value) => {
          vault.onCreate?.();
          if (files.has(path)) throw new Error(`File already exists: ${path}`);
          return add(path, value);
        },
        read: async (file) => content.get(file.path) ?? "",
        process: async (file, transform) => {
          processCalls += 1;
          const next = transform(content.get(file.path) ?? "");
          content.set(file.path, next);
          return next;
        },
      },
      openEditor: (file) => open?.(file),
    }),
  };
  return vault;
}

function fakeFile(path: string): TFile {
  return { path } as unknown as TFile;
}

function openEditor(initial: string): OpenSidecarEditor & {
  saves: number;
  edits: readonly { from: number; to: number; replacement: string }[];
} {
  let value = initial;
  let saves = 0;
  const edits: { from: number; to: number; replacement: string }[] = [];
  const editor = {
    getValue: () => value,
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    replaceRange: (replacement: string, from: { ch: number }, to: { ch: number }) => {
      edits.push({ from: from.ch, to: to.ch, replacement });
      value = value.slice(0, from.ch) + replacement + value.slice(to.ch);
    },
  } as unknown as Editor;
  return {
    editor,
    save: async () => { saves += 1; },
    get saves() { return saves; },
    edits,
  };
}
