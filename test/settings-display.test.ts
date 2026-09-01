import { describe, expect, test } from "bun:test";
import {
  apiKeyDescription,
  baseUrlDescription,
  catalogFetchFailedDescription,
  catalogLoadingDescription,
  claudeExecutableDescription,
  codexExecutableDescription,
  decideEffortRow,
  decideModelRow,
  effortNeedsModelDescription,
  newCharacterThresholdDescription,
  noEffortForModelDescription,
  passIntervalDescription,
  shorthandExecutableDescription,
  transcriptFolderDescription,
  unavailableOptionLabel,
  unavailableValueDescription,
} from "../src/settings-display.js";
import { DEFAULT_PLUGIN_SETTINGS } from "../src/settings.js";
import type { AgentCatalog, AgentModel, CatalogFailureReason } from "shorthand-core";

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
  test("the shipped default reads in the same seconds shown by the field", () => {
    expect(passIntervalDescription(25))
      .toBe("Live passes run no more often than once every 25 seconds.");
  });

  test("the plugin floor is ten seconds", () => {
    expect(passIntervalDescription(10))
      .toBe("Live passes run no more often than once every 10 seconds.");
  });

  test("invalid or sub-minimum input describes the value normalization will enforce", () => {
    expect(passIntervalDescription(0))
      .toBe("Live passes run no more often than once every 10 seconds.");
    expect(passIntervalDescription(Number.NaN))
      .toBe("Live passes run no more often than once every 10 seconds.");
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

describe("catalogLoadingDescription", () => {
  test("is a fixed sentence, not derived from any stored value", () => {
    expect(catalogLoadingDescription()).toBe("Loading available models…");
  });
});

describe("catalogFetchFailedDescription", () => {
  // One case per CatalogFailureReason, so a reason added to core without a matching branch
  // here fails typecheck rather than falling through silently.
  const reasons: readonly CatalogFailureReason[] = ["executable-not-found", "spawn-failed", "timeout", "protocol"];

  test("names the backend that failed for every reason", () => {
    for (const reason of reasons) {
      expect(catalogFetchFailedDescription("Claude", reason)).toContain("Claude");
      expect(catalogFetchFailedDescription("Codex", reason)).toContain("Codex");
    }
  });

  test("distinguishes every reason with its own wording", () => {
    const messages = reasons.map((reason) => catalogFetchFailedDescription("Codex", reason));
    expect(new Set(messages).size).toBe(reasons.length);
  });

  test("executable-not-found points at installing it or setting its path", () => {
    expect(catalogFetchFailedDescription("Claude", "executable-not-found"))
      .toBe("Shorthand could not find Claude. Install it, or set its path under Advanced.");
  });

  test("timeout and spawn-failed and protocol name the failure without inventing a fix", () => {
    expect(catalogFetchFailedDescription("Codex", "spawn-failed")).toBe("Shorthand could not start Codex.");
    expect(catalogFetchFailedDescription("Codex", "timeout")).toBe("Shorthand did not hear back from Codex in time.");
    expect(catalogFetchFailedDescription("Codex", "protocol"))
      .toBe("Shorthand could not understand Codex's response.");
  });

  test("all four branches are active voice, naming Shorthand as the actor", () => {
    for (const reason of reasons) {
      expect(catalogFetchFailedDescription("Codex", reason)).toMatch(/^Shorthand /);
    }
  });
});

describe("unavailableOptionLabel", () => {
  test("wraps the exact stored string in plain double quotes and flags it", () => {
    expect(unavailableOptionLabel("gpt-5.4")).toBe('"gpt-5.4" (unavailable)');
  });

  test("disambiguates an id that itself contains brackets", () => {
    expect(unavailableOptionLabel("opus[1m]")).toBe('"opus[1m]" (unavailable)');
  });
});

describe("unavailableValueDescription", () => {
  test("names the stored value and tells the user to pick another one", () => {
    expect(unavailableValueDescription("gpt-5.4")).toBe('"gpt-5.4" is not in the current list. Pick another one.');
  });

  test("quotes the value the same way unavailableOptionLabel does", () => {
    // Rule from finding 3: both name the same value, so both quote it the same way.
    const value = "claude-fable-5[1m]";
    const quoted = `"${value}"`;
    expect(unavailableOptionLabel(value)).toContain(quoted);
    expect(unavailableValueDescription(value)).toContain(quoted);
  });
});

describe("noEffortForModelDescription", () => {
  test("names the model that takes no effort setting", () => {
    expect(noEffortForModelDescription("Haiku")).toBe("Haiku doesn't take an effort setting.");
  });
});

describe("effortNeedsModelDescription", () => {
  test("is a fixed sentence, not derived from any stored value", () => {
    expect(effortNeedsModelDescription()).toBe("Pick a model to see its effort options.");
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

function agentModel(overrides: Partial<AgentModel> & Pick<AgentModel, "id" | "displayName">): AgentModel {
  return { description: "", efforts: [], ...overrides };
}

function agentCatalog(overrides: Partial<AgentCatalog> = {}): AgentCatalog {
  return { models: [], signedIn: true, ...overrides };
}

describe("decideModelRow", () => {
  const sonnet = agentModel({ id: "claude-sonnet-5", displayName: "Sonnet 5" });
  const opus = agentModel({ id: "opus[1m]", displayName: "Opus (1m)" });

  test("provider default is offered first, ahead of every catalog model", () => {
    const decision = decideModelRow(agentCatalog({ models: [sonnet, opus] }), "");
    expect(decision.selected).toBe("");
    expect(decision.description).toBe("");
    expect(decision.disabled).toBe(false);
    expect(decision.options).toEqual([
      { value: "", label: "Provider default", disabled: false },
      { value: "claude-sonnet-5", label: "Sonnet 5", disabled: false },
      { value: "opus[1m]", label: "Opus (1m)", disabled: false },
    ]);
  });

  test("a stored model still in the catalog is selected as a normal, enabled option", () => {
    const decision = decideModelRow(agentCatalog({ models: [sonnet] }), "claude-sonnet-5");
    expect(decision.selected).toBe("claude-sonnet-5");
    expect(decision.description).toBe("");
    expect(decision.options).toEqual([
      { value: "", label: "Provider default", disabled: false },
      { value: "claude-sonnet-5", label: "Sonnet 5", disabled: false },
    ]);
  });

  test("a stored model id absent from the catalog is kept selected, flagged, and disabled — not dropped", () => {
    const decision = decideModelRow(agentCatalog({ models: [sonnet] }), "gpt-5.4");
    expect(decision.selected).toBe("gpt-5.4");
    expect(decision.description).toBe('"gpt-5.4" is not in the current list. Pick another one.');
    expect(decision.options.at(-1)).toEqual({ value: "gpt-5.4", label: '"gpt-5.4" (unavailable)', disabled: true });
  });

  test("the row disables purely off catalog.signedIn, independent of whether the stored model is valid", () => {
    expect(decideModelRow(agentCatalog({ models: [sonnet], signedIn: false }), "claude-sonnet-5").disabled).toBe(true);
    expect(decideModelRow(agentCatalog({ models: [sonnet], signedIn: false }), "gpt-5.4").disabled).toBe(true);
    expect(decideModelRow(agentCatalog({ models: [sonnet], signedIn: true }), "claude-sonnet-5").disabled).toBe(false);
  });
});

describe("decideEffortRow", () => {
  const sonnetWithEfforts = agentModel({ id: "sonnet", displayName: "Sonnet", efforts: ["low", "high"] });
  const haikuNoEfforts = agentModel({ id: "haiku", displayName: "Haiku", efforts: [] });
  const opusWithHigh = agentModel({ id: "opus", displayName: "Opus", efforts: ["medium", "high"] });
  const gpt54WithoutHigh = agentModel({ id: "gpt-5.4", displayName: "GPT-5.4", efforts: ["low", "medium"] });

  test("branch 1a: no model selected and no stored effort — needs a model first", () => {
    const decision = decideEffortRow(agentCatalog({ models: [sonnetWithEfforts] }), "", "");
    expect(decision).toEqual({
      options: [{ value: "", label: "Provider default", disabled: false }],
      selected: "",
      description: "Pick a model to see its effort options.",
      disabled: true,
    });
  });

  test("branch 1b: no model selected (or the stored model isn't in the catalog) but a stored effort exists — kept, flagged", () => {
    const decision = decideEffortRow(agentCatalog({ models: [sonnetWithEfforts] }), "unknown-model", "high");
    expect(decision).toEqual({
      options: [
        { value: "", label: "Provider default", disabled: false },
        { value: "high", label: '"high" (unavailable)', disabled: true },
      ],
      selected: "high",
      description: '"high" is not in the current list. Pick another one.',
      disabled: true,
    });
  });

  test("branch 2: the selected model takes no effort at all", () => {
    const decision = decideEffortRow(agentCatalog({ models: [haikuNoEfforts] }), "haiku", "high");
    expect(decision).toEqual({
      options: [{ value: "", label: "Provider default", disabled: false }],
      selected: "",
      description: "Haiku doesn't take an effort setting.",
      disabled: true,
    });
  });

  test("branch 3a: the selected model has efforts and the stored one is among them — offered normally", () => {
    const decision = decideEffortRow(agentCatalog({ models: [sonnetWithEfforts] }), "sonnet", "high");
    expect(decision).toEqual({
      options: [
        { value: "", label: "Provider default", disabled: false },
        { value: "low", label: "Low", disabled: false },
        { value: "high", label: "High", disabled: false },
      ],
      selected: "high",
      description: "",
      disabled: false,
    });
  });

  test("branch 3b: the selected model has efforts but the stored one is not among them — kept, flagged", () => {
    const decision = decideEffortRow(agentCatalog({ models: [gpt54WithoutHigh] }), "gpt-5.4", "high");
    expect(decision).toEqual({
      options: [
        { value: "", label: "Provider default", disabled: false },
        { value: "low", label: "Low", disabled: false },
        { value: "medium", label: "Medium", disabled: false },
        { value: "high", label: '"high" (unavailable)', disabled: true },
      ],
      selected: "high",
      description: '"high" is not in the current list. Pick another one.',
      disabled: false,
    });
  });

  test("branch 3's row disables off catalog.signedIn, independent of whether the stored effort is valid", () => {
    expect(decideEffortRow(agentCatalog({ models: [sonnetWithEfforts], signedIn: false }), "sonnet", "high").disabled)
      .toBe(true);
    expect(decideEffortRow(agentCatalog({ models: [gpt54WithoutHigh], signedIn: false }), "gpt-5.4", "high").disabled)
      .toBe(true);
  });

  test("finding 1, compatible switch: a stored effort survives a model switch when the new model still accepts it", () => {
    // Both sonnetWithEfforts and opusWithHigh accept "high" — switching between them must not
    // discard it, unlike the old `main.ts` behaviour that cleared the effort on every switch.
    const decision = decideEffortRow(agentCatalog({ models: [opusWithHigh] }), "opus", "high");
    expect(decision.selected).toBe("high");
    expect(decision.description).toBe("");
    expect(decision.options.find((option) => option.value === "high")).toEqual({
      value: "high",
      label: "High",
      disabled: false,
    });
  });

  test("finding 1, incompatible switch: a stored effort is flagged, not silently dropped, when the new model can't accept it", () => {
    const decision = decideEffortRow(agentCatalog({ models: [gpt54WithoutHigh] }), "gpt-5.4", "high");
    expect(decision.selected).toBe("high");
    expect(decision.description).toBe('"high" is not in the current list. Pick another one.');
    expect(decision.options.find((option) => option.value === "high")).toEqual({
      value: "high",
      label: '"high" (unavailable)',
      disabled: true,
    });
  });
});
