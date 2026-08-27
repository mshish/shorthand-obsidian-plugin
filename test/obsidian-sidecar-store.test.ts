import { describe, expect, test } from "bun:test";
import type { TFile } from "obsidian";
import { ObsidianSidecarStore, type ObsidianSidecarApi } from "../src/obsidian-sidecar-store.js";

describe("ObsidianSidecarStore", () => {
  test("creates a vault-relative sidecar and its parent folder", async () => {
    const vault = memoryVault();
    const store = new ObsidianSidecarStore({ api: vault.api, path: "Calls/Transcript.md" });

    await expect(store.process((current) => {
      expect(current).toBeUndefined();
      return { content: "# Shorthand Transcript", value: "created" };
    })).resolves.toBe("created");

    expect(vault.folders).toContain("Calls");
    expect(vault.content.get("Calls/Transcript.md")).toBe("# Shorthand Transcript");
  });

  test("uses Vault.process for a background sidecar", async () => {
    const vault = memoryVault();
    const file = vault.add("Calls/Transcript.md", "before");
    const store = new ObsidianSidecarStore({ api: vault.api, path: file.path, file });

    await expect(store.process((current) => ({ content: `${current}\nafter`, value: 7 }))).resolves.toBe(7);
    expect(vault.processCalls).toBe(1);
    expect(vault.content.get(file.path)).toBe("before\nafter");
  });

  test("uses the active sidecar editor so its unsaved buffer is observed", async () => {
    const vault = memoryVault();
    const file = vault.add("Calls/Transcript.md", "saved");
    let editorValue = "unsaved";
    const store = new ObsidianSidecarStore({
      path: file.path,
      file,
      api: {
        ...vault.api,
        activeEditor: () => ({
          file,
          editor: {
            getValue: () => editorValue,
            setValue: (value) => { editorValue = value; },
          },
        }),
      },
    });

    await expect(store.process((current) => ({ content: `${current}\nwritten`, value: "editor" }))).resolves.toBe("editor");
    expect(editorValue).toBe("unsaved\nwritten");
    expect(vault.processCalls).toBe(0);
  });

  test("follows a TFile rename but rejects a replacement", async () => {
    const vault = memoryVault();
    const file = vault.add("Calls/Transcript.md", "before");
    const store = new ObsidianSidecarStore({ api: vault.api, path: file.path, file });

    vault.files.delete(file.path);
    vault.content.delete(file.path);
    Object.assign(file, { path: "Calls/Renamed transcript.md" });
    vault.files.set(file.path, file);
    vault.content.set(file.path, "before");
    await expect(store.process((current) => ({ content: `${current}\nafter`, value: "renamed" }))).resolves.toBe("renamed");

    vault.files.set(file.path, fakeFile(file.path));
    await expect(store.process((current) => ({ content: current ?? "", value: "replacement" })))
      .rejects.toThrow("deleted or replaced");
  });
});

function memoryVault(): {
  api: ObsidianSidecarApi;
  files: Map<string, TFile>;
  content: Map<string, string>;
  folders: string[];
  processCalls: number;
  add(path: string, content: string): TFile;
} {
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
  return {
    get processCalls() { return processCalls; },
    files,
    content,
    folders,
    add,
    api: {
      vault: {
        getFileByPath: (path) => files.get(path) ?? null,
        getAbstractFileByPath: (path) => folders.includes(path) ? {} : null,
        createFolder: async (path) => { folders.push(path); return {}; },
        create: async (path, value) => add(path, value),
        read: async (file) => content.get(file.path) ?? "",
        process: async (file, transform) => {
          processCalls += 1;
          const next = transform(content.get(file.path) ?? "");
          content.set(file.path, next);
          return next;
        },
      },
      activeEditor: () => undefined,
    },
  };
}

function fakeFile(path: string): TFile {
  return { path } as unknown as TFile;
}
