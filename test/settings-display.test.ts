import { describe, expect, test } from "bun:test";
import {
  apiKeyDescription,
  baseUrlDescription,
  claudeExecutableDescription,
  codexExecutableDescription,
  newCharacterThresholdDescription,
  passIntervalDescription,
  shorthandExecutableDescription,
  transcriptFolderDescription,
} from "../src/settings-display.js";
import { DEFAULT_PLUGIN_SETTINGS } from "../src/settings.js";

describe("shorthandExecutableDescription", () => {
  test("empty means core detects Shorthand, mirroring claudeExecutableDescription", () => {
    expect(shorthandExecutableDescription("")).toBe("Shorthand is found automatically.");
    expect(shorthandExecutableDescription("   ")).toBe("Shorthand is found automatically.");
  });

  test("the shipped default is blank and reports detection, not silence", () => {
    expect(shorthandExecutableDescription(DEFAULT_PLUGIN_SETTINGS.shorthandExecutable))
      .toBe("Shorthand is found automatically.");
  });

  test("a bare command name steers back to blank: it resolves relative to Obsidian's working folder, not PATH", () => {
    expect(shorthandExecutableDescription("shorthand"))
      .toBe("A bare name resolves relative to Obsidian's working folder, not PATH — clear the field to detect Shorthand automatically.");
  });

  test("a path describes nothing: the field already shows it", () => {
    expect(shorthandExecutableDescription("C:\\Tools\\shorthand.exe")).toBe("");
    expect(shorthandExecutableDescription("/usr/local/bin/shorthand")).toBe("");
  });
});

describe("claudeExecutableDescription", () => {
  test("empty means core detects the CLI, which is shown nowhere else", () => {
    expect(claudeExecutableDescription("")).toBe("Claude is found automatically.");
    expect(claudeExecutableDescription("   ")).toBe("Claude is found automatically.");
  });

  test("a configured path describes nothing", () => {
    expect(claudeExecutableDescription("C:\\Users\\me\\.local\\bin\\claude.exe")).toBe("");
  });
});

describe("codexExecutableDescription", () => {
  test("empty means core detects the CLI, and the shipped default is empty", () => {
    const detected = "Codex is found automatically.";
    expect(codexExecutableDescription("")).toBe(detected);
    expect(codexExecutableDescription("   ")).toBe(detected);
    expect(codexExecutableDescription(DEFAULT_PLUGIN_SETTINGS.codexExecutable)).toBe(detected);
  });

  test("reads as the Claude row does, differing only in the name of the binary", () => {
    // The inversion of the assertion that stood here, and deliberate rather than a relaxation.
    // It used to pin the two rows *apart* — `not.toBe(claudeExecutableDescription(""))` — because
    // an empty Codex field really was a broken backend while an empty Claude field was a working
    // default, and a copy-edit that harmonised them would have told the user a lie. Core 0.11.2
    // searches PATH for Codex, so the two rows now describe the same thing about two binaries,
    // and what needs guarding is the reverse: a future divergence should be deliberate.
    expect(codexExecutableDescription("").replace("Codex", "Claude")).toBe(claudeExecutableDescription(""));
  });

  test("a configured path describes nothing", () => {
    expect(codexExecutableDescription("C:\\npm\\@openai\\codex\\vendor\\bin\\codex.exe")).toBe("");
  });
});

describe("transcriptFolderDescription", () => {
  test("names the folder in force", () => {
    expect(transcriptFolderDescription("Meetings/Transcripts"))
      .toBe("New transcript notes go in Meetings/Transcripts.");
  });

  test("tracks the shipped default", () => {
    expect(transcriptFolderDescription(DEFAULT_PLUGIN_SETTINGS.sidecarDirectory))
      .toBe("New transcript notes go in Meetings/Transcripts.");
  });
});

describe("newCharacterThresholdDescription", () => {
  test("plural for the shipped default", () => {
    expect(newCharacterThresholdDescription(180))
      .toBe("A live pass waits until 180 new characters of transcript have arrived.");
  });

  test("singular at one", () => {
    expect(newCharacterThresholdDescription(1))
      .toBe("A live pass waits until 1 new character of transcript has arrived.");
  });

  test("a nonsensical stored value still reads as a sentence", () => {
    // normalizePluginSettings floors this at 1, but data.json is user-editable and this
    // function must never render "0 new characters ... have arrived".
    expect(newCharacterThresholdDescription(0))
      .toBe("A live pass waits until 1 new character of transcript has arrived.");
    expect(newCharacterThresholdDescription(Number.NaN))
      .toBe("A live pass waits until 1 new character of transcript has arrived.");
  });
});

describe("passIntervalDescription", () => {
  test("the shipped default reads in seconds and names the unit of the field", () => {
    expect(passIntervalDescription(25_000))
      .toBe("Live passes run no more often than once every 25 seconds. The value is in milliseconds.");
  });

  test("one second is singular", () => {
    expect(passIntervalDescription(1_000))
      .toBe("Live passes run no more often than once every 1 second. The value is in milliseconds.");
  });

  test("one millisecond is singular", () => {
    expect(passIntervalDescription(1))
      .toBe("Live passes run no more often than once every 1 millisecond. The value is in milliseconds.");
  });

  test("under a second stays in milliseconds rather than rounding to zero", () => {
    expect(passIntervalDescription(250))
      .toBe("Live passes run no more often than once every 250 milliseconds. The value is in milliseconds.");
  });

  test("a minute and over reads in minutes", () => {
    expect(passIntervalDescription(120_000))
      .toBe("Live passes run no more often than once every 2 minutes. The value is in milliseconds.");
    expect(passIntervalDescription(90_000))
      .toBe("Live passes run no more often than once every 1 minute 30 seconds. The value is in milliseconds.");
  });

  test("the duration is faithful to the stored milliseconds, never rounded to a tidier one", () => {
    // Divides evenly, so it reads as seconds.
    expect(passIntervalDescription(30_000))
      .toBe("Live passes run no more often than once every 30 seconds. The value is in milliseconds.");
    // Does not divide evenly. "2 seconds" would name a value the user never entered, and
    // data.json is hand-editable, so this is reachable.
    expect(passIntervalDescription(1_500))
      .toBe("Live passes run no more often than once every 1500 milliseconds. The value is in milliseconds.");
    expect(passIntervalDescription(1_499))
      .toBe("Live passes run no more often than once every 1499 milliseconds. The value is in milliseconds.");
    expect(passIntervalDescription(90_500))
      .toBe("Live passes run no more often than once every 90500 milliseconds. The value is in milliseconds.");
    // The field's floor, which must stay singular.
    expect(passIntervalDescription(1))
      .toBe("Live passes run no more often than once every 1 millisecond. The value is in milliseconds.");
  });

  test("zero is a legal stored value and gets its own sentence", () => {
    // minIntervalMs normalizes with a floor of 0, so this is reachable from the UI.
    expect(passIntervalDescription(0))
      .toBe("Live passes run with no minimum gap between them. The value is in milliseconds.");
  });
});

describe("baseUrlDescription", () => {
  test("required for openai-compatible, because the name identifies no endpoint", () => {
    expect(baseUrlDescription("openai-compatible"))
      .toBe("Required. The provider name alone does not identify an endpoint.");
  });

  test("optional for the named providers, and while none is chosen", () => {
    const optional = "Optional. Leave it blank unless you route through a gateway or proxy.";
    expect(baseUrlDescription("openai")).toBe(optional);
    expect(baseUrlDescription("anthropic")).toBe(optional);
    expect(baseUrlDescription("")).toBe(optional);
  });
});

describe("apiKeyDescription", () => {
  const semantics = "Blank keeps the stored key, a new value replaces it, and Clear key removes it.";

  test("a stored key explains what blank does to it, because the field cannot show it", () => {
    expect(apiKeyDescription("stored")).toBe(`A key is stored. ${semantics}`);
  });

  test("the states that can take none of those three actions offer none of them", () => {
    // Nothing stored: blank keeps nothing and Clear key removes nothing. Unreadable profile:
    // renderMalformed disables the field and the Clear key button before setting this
    // description, so all three are unavailable while the sentence is on screen.
    expect(apiKeyDescription("absent")).toBe("No key is stored.");
    expect(apiKeyDescription("unknown")).toBe("The stored key cannot be read.");
  });
});
